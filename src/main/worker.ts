/** Worker for read scans only. One per request; it posts the result and exits. Progress is posted as { progress } */
import { parentPort, workerData } from 'node:worker_threads'
import { runOp, type Op } from './reads'

const { op, home, env, args } = workerData as {
  op: Op
  home: string
  env: Record<string, string>
  args?: unknown[]
}

Promise.resolve()
  .then(() => runOp(op, home, env, args ?? [], (progress) => parentPort!.postMessage({ progress })))
  .then(
    (value) => parentPort!.postMessage({ ok: true, value }),
    // Do not send stacks, which may contain source text
    (e) => parentPort!.postMessage({ ok: false, message: (e as Error)?.message ?? String(e) })
  )
