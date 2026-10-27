const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

// Small JSON-backed store for the device identity and user preferences.
class Settings {
  constructor(dir, defaults) {
    this.file = path.join(dir, 'settings.json');
    let saved = {};
    try {
      saved = JSON.parse(fs.readFileSync(this.file, 'utf8'));
    } catch {
      // First launch or unreadable file: start fresh.
    }
    this.data = { id: crypto.randomUUID(), trusted: {}, ...defaults, ...saved };
    this.save();
  }

  get(key) {
    return this.data[key];
  }

  set(key, value) {
    this.data[key] = value;
    this.save();
  }

  save() {
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    fs.writeFileSync(this.file, JSON.stringify(this.data, null, 2));
  }
}

module.exports = { Settings };
