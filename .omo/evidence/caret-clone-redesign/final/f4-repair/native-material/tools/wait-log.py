#!/usr/bin/env python3
import os, select, sys, time
path, offset, needle, timeout = sys.argv[1], int(sys.argv[2]), sys.argv[3], float(sys.argv[4])
deadline = time.monotonic() + timeout
fd = os.open(path, os.O_RDONLY)
kq = select.kqueue()
kq.control([select.kevent(fd, filter=select.KQ_FILTER_VNODE, flags=select.KQ_EV_ADD | select.KQ_EV_CLEAR, fflags=select.KQ_NOTE_WRITE | select.KQ_NOTE_EXTEND)], 0)
def matched():
    with open(path, encoding="utf-8") as handle:
        handle.seek(offset)
        return needle in handle.read()
try:
    while not matched():
        remaining = deadline - time.monotonic()
        if remaining <= 0 or not kq.control(None, 1, remaining): raise SystemExit("deadline waiting for exact launcher log event")
finally:
    kq.close(); os.close(fd)
