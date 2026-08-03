// Message types on the chrome<->whiteboard-frame postMessage channel.
// Both sides import this; a rename here can never half-land.

export const WB = {
  ready: 'easel-whiteboard:ready',
  init: 'easel-whiteboard:init',
  save: 'easel-whiteboard:save',
  saveResult: 'easel-whiteboard:saveResult',
  flush: 'easel-whiteboard:flush',
  flushComplete: 'easel-whiteboard:flushComplete',
  prepareTeardown: 'easel-whiteboard:prepareTeardown',
  teardownReady: 'easel-whiteboard:teardownReady',
  teardownFailed: 'easel-whiteboard:teardownFailed',
  queueFeedback: 'easel-whiteboard:queueFeedback',
  queueResult: 'easel-whiteboard:queueResult',
  close: 'easel-whiteboard:close',
  themeChanged: 'easel-whiteboard:themeChanged',
  sourceChanged: 'easel-whiteboard:sourceChanged',
  boardEnded: 'easel-whiteboard:boardEnded',
}
