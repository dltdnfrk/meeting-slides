# Edge cases
- empty DB / empty items → empty state visible, count 0
- malformed `items: null` → treated as [] without crash
- historical row click → status toast stub, no throw
- adversarial not-applicable: prompt injection N/A (no model HTML path)
