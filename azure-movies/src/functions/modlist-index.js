// modlist-index.js — loads the chunked modlist catalogue.
// Split into parts because a single 5MB file exceeds the push
// tool's request size limit. Rebuilt by tools/build-modlist-index.py.
const { MODLIST_INDEX_1 } = require("./modlist-index-1.js");
const { MODLIST_INDEX_2 } = require("./modlist-index-2.js");
const { MODLIST_INDEX_3 } = require("./modlist-index-3.js");
const { MODLIST_INDEX_4 } = require("./modlist-index-4.js");
const { MODLIST_INDEX_5 } = require("./modlist-index-5.js");
const { MODLIST_INDEX_6 } = require("./modlist-index-6.js");
const { MODLIST_INDEX_7 } = require("./modlist-index-7.js");
const MODLIST_INDEX = [
  ...MODLIST_INDEX_1,
  ...MODLIST_INDEX_2,
  ...MODLIST_INDEX_3,
  ...MODLIST_INDEX_4,
  ...MODLIST_INDEX_5,
  ...MODLIST_INDEX_6,
  ...MODLIST_INDEX_7,
];
module.exports = { MODLIST_INDEX };
