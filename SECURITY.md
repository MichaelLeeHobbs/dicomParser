# Security Policy

## Reporting a Vulnerability

Please report vulnerabilities privately via GitHub's
[private vulnerability reporting](https://github.com/MichaelLeeHobbs/dicomParser/security/advisories/new)
for this repository. Do **not** open a public issue for security problems.

You can expect an acknowledgement within 72 hours. Please include a minimal
reproducing input (a crafted DICOM file or byte sequence) where possible.

## Scope

This library parses and writes untrusted binary input (DICOM Part-10). Reports of
particular interest:

- Out-of-bounds reads, infinite loops, or unbounded memory growth triggered by
  malformed lengths, offsets, truncation, or deeply nested sequences
- Decompression issues on the deflated transfer syntax path (zip-bomb class)
- Any input that crashes the process rather than returning a typed error

## Supported Versions

Only the latest published 2.x release line receives security fixes. The upstream
1.x line (`dicom-parser` on npm, cornerstonejs/dicomParser) is not maintained here —
report 1.x issues upstream, but note this fork exists partly because upstream
lacks an active security-response process.
