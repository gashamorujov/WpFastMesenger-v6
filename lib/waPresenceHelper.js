/** Thin wrapper so lib/ and modules/ can share the same presence cache. */
const { checkRegistered } = require('../modules/waPresence');
module.exports = { checkRegistered };
