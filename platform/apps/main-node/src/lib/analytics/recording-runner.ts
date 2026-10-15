import type { NodeManagedSessionRunner } from '../node-managed-session-runtime.js';
import type { ModelCallRecorder } from './model-call-recorder.js';
export function withModelCallRecording(runner: NodeManagedSessionRunner, recorder: ModelCallRecorder): NodeManagedSessionRunner {
  return {
    start: input => runner.start(input),
    stop: input => runner.stop(input),
    archiveThread: input => runner.archiveThread(input),
    accept: input => {
      const tap = recorder.tap(input);
      return runner.accept({...input, output: async frame => { await input.output(frame); tap(frame); }});
    },
  };
}
