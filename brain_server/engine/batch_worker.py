"""`server.py --engine batch`: all flies in ONE process sharing ONE connectome.

Same message contract as worker.run (ready / brain messages, same pipes): every fly runs
worker.fly_loop (identical smoothing, habituation, decoder, cloud bits) in its own thread on
a FlyBatch clone. The native kernel releases the GIL, so flies integrate in parallel.
"""

import sys
import threading
import traceback
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))  # brain_server/


def run(ends, subset, step_ms, kernel="fast"):
    """ends: [(fly, inbox, outbox)] — the same pipe ends worker.run gets, one tuple per fly."""
    import worker
    from engine.engine import FlyBatch

    batch = FlyBatch(len(ends), kernel)
    indices = worker.prepare(batch.proto)

    # all flies step together so the GPU rendezvous batches them into ONE dispatch
    barrier = threading.Barrier(len(ends))

    def guarded(brain, fly, inbox, outbox):
        try:
            worker.fly_loop(brain, indices, fly, inbox, outbox, subset, step_ms, barrier)
        except Exception:
            traceback.print_exc()
        finally:
            outbox.close()

    threads = [
        threading.Thread(target=guarded, args=(b, fly, i, o), name=f"fly{fly}", daemon=True)
        for b, (fly, i, o) in zip(batch.brains, ends)
    ]
    for t in threads:
        t.start()
    for t in threads:
        t.join()
