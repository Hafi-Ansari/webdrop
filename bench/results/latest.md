# Benchmark 2026-10-11T00:18:52.755Z

256 MiB synthetic file, 3 run(s) each, receiver sink: opfs, send buffer 8/2 MiB, loopback on darwin/arm64.

| browsers | chunk | MB/s (best) | runs |
|---|---|---|---|
| chromium→chromium | 64 KiB | 30.0 | 24.3, 27.2, 30.0 |
| chromium→chromium | 128 KiB | 25.6 | 21.4, 24.3, 25.6 |
| chromium→chromium | 256 KiB | 23.8 | 19.3, 22.2, 23.8 |
