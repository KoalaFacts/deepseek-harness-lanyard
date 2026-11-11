#!/usr/bin/env bash
# Only the fixture contains shell source. The caller's executable and file
# paths arrive as argv, and quoted "$@" forwards them without interpolation.
# A 1 KiB POSIX file-size limit reproduces EFBIG after a partial PEM write.
set -e
ulimit -f 1
trap '' XFSZ
exec "$@"
