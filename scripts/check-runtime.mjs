#!/usr/bin/env node
// Focused runtime verification: fail clearly below the supported Node major so
// CI and local gates stop early, while npm still shows its normal engine
// message from the engines field on install.
const major = Number(process.versions.node.split(".")[0]);
if (major < 24) {
  console.error(
    "kestrel requires Node.js 24 or newer (found " +
      process.versions.node +
      "). Activate the runtime (nvm use 24.19.0) and retry.",
  );
  process.exit(1);
}
console.log("Node.js " + process.versions.node + " (required >=24)");
