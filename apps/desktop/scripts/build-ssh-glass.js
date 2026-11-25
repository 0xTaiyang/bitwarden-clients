/* eslint-disable @typescript-eslint/no-require-imports */
const { execFileSync } = require("node:child_process");
const { mkdirSync } = require("node:fs");
const path = require("node:path");

// Node-API keeps this bridge independent of Electron's Node/V8 ABI.
module.exports = function buildSshGlass(outputPath) {
  if (process.platform !== "darwin") {
    return;
  }
  const headers = path.join(path.dirname(require.resolve("emnapi/package.json")), "include/node");
  mkdirSync(outputPath, { recursive: true });
  execFileSync(
    "xcrun",
    [
      "clang++",
      "-bundle",
      "-undefined",
      "dynamic_lookup",
      "-fobjc-arc",
      "-mmacosx-version-min=12.0",
      "-arch",
      "arm64",
      "-arch",
      "x86_64",
      "-I",
      headers,
      "-framework",
      "AppKit",
      path.resolve(__dirname, "../desktop_native/ssh-glass.mm"),
      "-o",
      path.join(outputPath, "ssh-glass.node"),
    ],
    { stdio: "inherit" },
  );
};
