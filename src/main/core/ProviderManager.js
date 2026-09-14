'use strict';

const { YouTubeProvider } = require('../providers/YouTubeProvider');
const { FacebookProvider } = require('../providers/FacebookProvider');

class ProviderManager {
  constructor() {
    /** @type {import('../providers/BaseProvider').BaseProvider[]} */
    this.providers = [new YouTubeProvider(), new FacebookProvider()];
  }

  list() {
    return this.providers.map((p) => ({ id: p.id, displayName: p.displayName }));
  }

  resolve(url) {
    return this.providers.find((p) => p.canHandle(url)) || null;
  }

  register(provider) {
    // Enables future providers to be added without touching this file
    // at all if desired (e.g. via a plugin loader).
    this.providers.push(provider);
  }
}

module.exports = { ProviderManager };
