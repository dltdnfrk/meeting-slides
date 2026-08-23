#!/usr/bin/env python3
import json, os, select, sys, time

path, kind, minimum, timeout = sys.argv[1], sys.argv[2], int(sys.argv[3]), float(sys.argv[4])
deadline = time.monotonic() + timeout
fd = os.open(path, os.O_RDONLY)
kq = select.kqueue()
kq.control([select.kevent(fd, filter=select.KQ_FILTER_VNODE, flags=select.KQ_EV_ADD | select.KQ_EV_CLEAR, fflags=select.KQ_NOTE_WRITE | select.KQ_NOTE_EXTEND | select.KQ_NOTE_RENAME)], 0)

def matches():
    with open(path, encoding="utf-8") as handle:
        rows = [json.loads(line) for line in handle if line.strip()]
    return len([row for row in rows if row.get("kind") == kind]) >= minimum

try:
    while not matches():
        remaining = deadline - time.monotonic()
        if remaining <= 0 or not kq.control(None, 1, remaining):
            raise SystemExit(f"deadline waiting for {minimum} {kind} receipt(s)")
finally:
    kq.close()
    os.close(fd)
