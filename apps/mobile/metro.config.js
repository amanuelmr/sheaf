// The workspace root must be watched so Metro picks up edits to packages/*, which
// are imported straight from TypeScript source. Everything else is left to
// expo/metro-config: with a hoisted node_modules (see the root .npmrc) the usual
// monorepo resolver overrides are unnecessary, and `disableHierarchicalLookup`
// actively fights Expo's defaults.
const { getDefaultConfig } = require('expo/metro-config');
const path = require('node:path');

const config = getDefaultConfig(__dirname);
config.watchFolders = [path.resolve(__dirname, '../..')];

module.exports = config;
