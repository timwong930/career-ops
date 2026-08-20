#!/usr/bin/osascript -l JavaScript

// macOS-native PDF text extraction for Career-Ops CV import.
// Uses PDFKit only; nothing leaves the machine and no third-party parser is needed.
ObjC.import("Foundation");
ObjC.import("PDFKit");

function run(argv) {
  if (!argv || argv.length < 1) return "";
  const filePath = String(argv[0]);
  const url = $.NSURL.fileURLWithPath($(filePath));
  const doc = $.PDFDocument.alloc.initWithURL(url);
  if (!doc) return "";
  const text = doc.string;
  if (!text) return "";
  try {
    return text.js || "";
  } catch (_) {
    return ObjC.unwrap(text) || "";
  }
}
