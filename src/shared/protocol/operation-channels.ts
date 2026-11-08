import { Commands } from './commands'
export const OPERATION_CHANNELS: ReadonlySet<string> = new Set([
  Commands.UpdatePluginOperationDraft,
  Commands.RevealPluginOperation,
  Commands.GetPluginOperations,
  Commands.PreparePluginOperation,
  Commands.PickPluginOperationFile,
  Commands.GetPluginOperationPicker,
  Commands.DiscardPluginOperation,
  Commands.StartPluginOperation,
  Commands.GetPluginOperationJob,
  Commands.CancelPluginOperation,
])

/**
 * Commands whose handler receives the caller's owner principal as its first
 * argument: the plugin operation commands and the media picker's resolve and
 * cancel, whose state belongs to the client that started it.
 */
export const OWNER_SCOPED_CHANNELS: ReadonlySet<string> = new Set([
  ...OPERATION_CHANNELS,
  Commands.ResolveMedia,
  Commands.CancelMediaResolve,
])
