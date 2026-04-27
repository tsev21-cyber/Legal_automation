const fs = require('fs');
const os = require('os');
const path = require('path');

const COMMON_PATHS = [
  process.env.CHROME_PATH,
  path.join(os.homedir(), 'AppData/Local/Google/Chrome/Application/chrome.exe'),
  path.join(os.homedir(), 'AppData/Local/Google/Chrome/Bin/chrome.exe'),
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe',
];

function findChrome() {
  for (const p of COMMON_PATHS) {
    if (p && fs.existsSync(p)) return p;
  }
  return null; // let Playwright use channel:'chrome' auto-detection
}

function chromiumLaunchOptions(extra = {}) {
  const executablePath = findChrome();
  const opts = { headless: true, ...extra };
  if (executablePath) {
    opts.executablePath = executablePath;
  } else {
    opts.channel = 'chrome';
  }
  return opts;
}

module.exports = { findChrome, chromiumLaunchOptions };
