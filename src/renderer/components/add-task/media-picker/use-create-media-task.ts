import { invalidateTaskList } from '@renderer/hooks/use-task-list'
import { transport } from '@renderer/lib/transport'
import { Commands } from '@shared/protocol/commands'
import type {
  TaskCreateCommandResult,
  TaskCreateRequest,
} from '@shared/schemas/add-task'
import { useCallback } from 'react'

/**
 * `CreateTask` for the media picker. The task list is refreshed after each
 * created task, so parts show up while the rest are still being added.
 */
export function useCreateMediaTask() {
  return useCallback(
    async (request: TaskCreateRequest): Promise<TaskCreateCommandResult> => {
      const result = (await transport.invoke(
        Commands.CreateTask,
        request
      )) as TaskCreateCommandResult
      if (result.outcome !== 'invalid-source' && result.outcome !== 'conflict')
        invalidateTaskList()
      return result
    },
    []
  )
}
