const dgram = require('node:dgram');
const os = require('node:os');
const { EventEmitter } = require('node:events');

const DISCOVERY_PORT = 47800;
const BEACON_INTERVAL = 1500;
// Wi-Fi drops broadcast packets, especially under load or when a Mac's radio naps, so allow
// several missed beacons before a device leaves the radar.
const PEER_TTL = 10000;
const PROTOCOL = 'hop/1';

// Every IPv4 broadcast address of the machine's LAN interfaces, plus the global one.
// Some routers drop 255.255.255.255, so subnet broadcasts are what usually gets through.
function broadcastAddresses() {
  const out = new Set(['255.255.255.255']);
  for (const addrs of Object.values(os.networkInterfaces())) {
    for (const a of addrs || []) {
      if (a.family !== 'IPv4' || a.internal || !a.netmask) continue;
      const ip = a.address.split('.').map(Number);
      const mask = a.netmask.split('.').map(Number);
      out.add(ip.map((octet, i) => (octet & mask[i]) | (~mask[i] & 255)).join('.'));
    }
  }
  return [...out];
}

// Finds other Hop instances on the local network with UDP broadcast beacons.
// Emits 'change' with the current peer list whenever a peer appears, changes or leaves.
class Discovery extends EventEmitter {
  constructor(self, { port = DISCOVERY_PORT } = {}) {
    super();
    this.self = self;
    this.port = port;
    this.peers = new Map();
  }

  start() {
    this.socket = dgram.createSocket({ type: 'udp4', reuseAddr: true });
    this.socket.on('message', (msg, rinfo) => this.handle(msg, rinfo));
    this.socket.on('error', (err) => this.emit('error', err));
    this.socket.bind(this.port, () => {
      this.socket.setBroadcast(true);
      this.beacon();
    });
    this.timer = setInterval(() => {
      this.beacon();
      this.sweep();
    }, BEACON_INTERVAL);
  }

  stop() {
    clearInterval(this.timer);
    if (!this.socket) return;
    this.send({ type: 'bye' });
    const socket = this.socket;
    this.socket = null;
    setTimeout(() => socket.close(), 100);
  }

  // Re-announce right away, e.g. after the user renames this device.
  update(patch) {
    Object.assign(this.self, patch);
    this.beacon();
  }

  list() {
    return [...this.peers.values()].map(({ lastSeen, ...peer }) => peer);
  }

  get(id) {
    return this.peers.get(id);
  }

  // Traffic from a peer (a transfer in either direction) proves it's alive even when its
  // beacons are getting lost, so it keeps the peer on the radar too.
  touch(id) {
    const peer = this.peers.get(id);
    if (peer) peer.lastSeen = Date.now();
  }

  beacon() {
    this.send({ type: 'hello' });
  }

  send(extra) {
    if (!this.socket) return;
    const { id, name, platform, port } = this.self;
    const msg = Buffer.from(JSON.stringify({ proto: PROTOCOL, id, name, platform, port, ...extra }));
    for (const address of broadcastAddresses()) {
      this.socket.send(msg, this.port, address, () => {});
    }
  }

  handle(msg, rinfo) {
    let data;
    try {
      data = JSON.parse(msg.toString());
    } catch {
      return;
    }
    if (data.proto !== PROTOCOL || !data.id || data.id === this.self.id) return;

    if (data.type === 'bye') {
      if (this.peers.delete(data.id)) this.changed();
      return;
    }

    const prev = this.peers.get(data.id);
    const peer = {
      id: data.id,
      name: String(data.name || 'Unknown').slice(0, 64),
      platform: data.platform,
      address: rinfo.address,
      port: Number(data.port),
      lastSeen: Date.now(),
    };
    this.peers.set(peer.id, peer);
    if (!prev || prev.name !== peer.name || prev.address !== peer.address || prev.port !== peer.port) {
      this.changed();
    }
  }

  sweep() {
    const now = Date.now();
    let removed = false;
    for (const [id, peer] of this.peers) {
      if (now - peer.lastSeen > PEER_TTL) {
        this.peers.delete(id);
        removed = true;
      }
    }
    if (removed) this.changed();
  }

  changed() {
    this.emit('change', this.list());
  }
}

module.exports = { Discovery, DISCOVERY_PORT };
