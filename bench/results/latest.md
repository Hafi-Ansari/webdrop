# Benchmark 2026-10-11T00:36:16.503Z

256 MiB synthetic file, 4 run(s) each, receiver sink: opfs, send buffer 8/2 MiB, persistent profiles, loopback on darwin/arm64.

| browsers | chunk | MB/s (best) | runs |
|---|---|---|---|
| chromium→chromium | 128 KiB | 29.6 | 22.3, 23.9, 27.1, 29.6 |
| chromium→chromium | 64 KiB | 30.5 | 22.3, 30.5, 30.2, 27.5 |
| chromium→chromium | 256 KiB | 79.5 | 32.0, 73.9, 69.5, 79.5 |
