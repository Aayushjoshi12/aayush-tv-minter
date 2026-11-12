// modlist-index.js — loads the chunked modlist catalogue.
// Split into parts because a single 5MB file exceeds the push
// tool's request size limit. Rebuilt by tools/build-modlist-index.py.
import { MODLIST_INDEX_1 } from "./modlist-index-1.js";
import { MODLIST_INDEX_2 } from "./modlist-index-2.js";
import { MODLIST_INDEX_3 } from "./modlist-index-3.js";
import { MODLIST_INDEX_4 } from "./modlist-index-4.js";
import { MODLIST_INDEX_5 } from "./modlist-index-5.js";
import { MODLIST_INDEX_6 } from "./modlist-index-6.js";
import { MODLIST_INDEX_7 } from "./modlist-index-7.js";
export const MODLIST_INDEX = [
  ...MODLIST_INDEX_1,
  ...MODLIST_INDEX_2,
  ...MODLIST_INDEX_3,
  ...MODLIST_INDEX_4,
  ...MODLIST_INDEX_5,
  ...MODLIST_INDEX_6,
  ...MODLIST_INDEX_7,
];
