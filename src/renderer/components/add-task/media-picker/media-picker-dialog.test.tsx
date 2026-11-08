import { render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, describe, expect, it, onTestFinished, vi } from 'vitest'
import '@testing-library/jest-dom/vitest'
import '@renderer/lib/i18n'
import type { PlatformServices } from '@renderer/platform/services'
import { PlatformServicesProvider } from '@renderer/platform/services'
import { Commands } from '@shared/protocol/commands'
import type {
  MediaPreview,
  MediaPreviewEntry,
  MediaPreviewVariant,
  ResolveMediaResult,
} from '@shared/schemas/media-resolution'
import { holdExitAnimation } from '@test-utils/hold-exit-animation'
import { useState } from 'react'
import {
  EMPTY_PICK_SESSION,
  type HttpTaskCreateRequest,
  MediaPickerDialog,
  type MediaPickerTarget,
  type MediaPickSession,
} from './media-picker-dialog'

const { invokeMock } = vi.hoisted(() => ({ invokeMock: vi.fn() }))
vi.mock('@renderer/lib/transport', () => ({
  transport: { invoke: invokeMock, on: vi.fn(), off: vi.fn() },
}))
vi.mock('@renderer/hooks/use-task-list', () => ({
  invalidateTaskList: vi.fn(),
}))

const PAGE = 'https://media.test/watch/1'
const RESOLUTION = '0190a6d0-0000-7000-8000-000000000001'

function variant(
  id: string,
  height: number,
  extra: Partial<MediaPreviewVariant> = {}
): MediaPreviewVariant {
  return {
    id,
    label: `${height}P`,
    height,
    container: 'mp4',
    requiresFfmpeg: false,
    recommended: false,
    ...extra,
  }
}

function entry(
  index: number,
  extra: Partial<MediaPreviewEntry> = {}
): MediaPreviewEntry {
  return {
    id: `ep:${index}`,
    index,
    title: `Episode ${index}`,
    current: index === 1,
    variants: [variant('hd', 1080, { recommended: true }), variant('sd', 480)],
    ...extra,
  }
}

function preview(extra: Partial<MediaPreview> = {}): MediaPreview {
  return {
    resolutionId: RESOLUTION,
    pluginId: 'example.media-resolver',
    pluginName: 'Example Resolver',
    title: 'Sample Series',
    defaultEntryId: 'ep:1',
    ffmpegAvailable: true,
    expiresAt: Date.now() + 600_000,
    folderName: 'Sample Series',
    warnAboveParts: 50,
    entries: [entry(1), entry(2), entry(3)],
    ...extra,
  }
}

const notify = vi.fn()
const services: PlatformServices = {
  kind: 'electron',
  pickSaveDir: vi.fn(),
  closeHost: vi.fn(),
  readClipboard: vi.fn().mockResolvedValue(''),
  openExternal: vi.fn(),
  notify,
}

const base: HttpTaskCreateRequest = {
  type: 'http',
  uris: [PAGE],
  saveDir: '/downloads',
  headers: [],
}

type DialogProps = Parameters<typeof MediaPickerDialog>[0]

/** Keeps the page sessions the way the form's provider does. */
function SessionHost(props: Omit<DialogProps, 'session' | 'onSessionChange'>) {
  const [sessions, setSessions] = useState(
    () => new Map<string, MediaPickSession>()
  )
  return (
    <MediaPickerDialog
      {...props}
      session={
        (props.target && sessions.get(props.target.url)) || EMPTY_PICK_SESSION
      }
      onSessionChange={(url, update) =>
        setSessions((current) =>
          new Map(current).set(
            url,
            update(current.get(url) ?? EMPTY_PICK_SESSION)
          )
        )
      }
    />
  )
}

function renderDialog(
  target: MediaPickerTarget | null = {
    url: PAGE,
    pluginName: 'Example Resolver',
  },
  props: Partial<Omit<DialogProps, 'session' | 'onSessionChange'>> = {}
) {
  const onClose = vi.fn()
  const onCreated = vi.fn()
  const element = (next: MediaPickerTarget | null) => (
    <PlatformServicesProvider services={services}>
      <SessionHost
        target={next}
        requestBase={() => ({ ok: true, request: base })}
        onClose={onClose}
        onCreated={onCreated}
        {...props}
      />
    </PlatformServicesProvider>
  )
  const view = render(element(target))
  return {
    onClose,
    onCreated,
    rerender: (next: MediaPickerTarget | null) => view.rerender(element(next)),
  }
}

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((r) => {
    resolve = r
  })
  return { promise, resolve }
}

function resolveWith(result: ResolveMediaResult | ((request: any) => any)) {
  invokeMock.mockImplementation(async (channel: string, request: any) => {
    if (channel === Commands.ResolveMedia)
      return typeof result === 'function' ? result(request) : result
    if (channel === Commands.CreateTask) return { gid: 'gid', taskId: 'task' }
    return { cancelled: true }
  })
}

function createCalls(): HttpTaskCreateRequest[] {
  return invokeMock.mock.calls
    .filter(([channel]) => channel === Commands.CreateTask)
    .map(([, request]) => request)
}

afterEach(() => {
  invokeMock.mockReset()
  notify.mockReset()
})

describe('MediaPickerDialog', () => {
  it('cancels a running resolve on the host when the user cancels', async () => {
    const pending = deferred<ResolveMediaResult>()
    invokeMock.mockImplementation(async (channel: string) =>
      channel === Commands.ResolveMedia ? pending.promise : { cancelled: true }
    )
    const { onClose, rerender } = renderDialog()
    expect(
      await screen.findByText('Reading the page with Example Resolver…')
    ).toBeInTheDocument()
    const [, request] = invokeMock.mock.calls[0]
    expect(request).toEqual({ requestId: expect.any(String), url: PAGE })

    await userEvent.click(screen.getByRole('button', { name: 'Cancel' }))
    expect(onClose).toHaveBeenCalled()
    rerender(null)
    await waitFor(() =>
      expect(invokeMock).toHaveBeenCalledWith(Commands.CancelMediaResolve, {
        requestId: request.requestId,
      })
    )
    // The reply of the cancelled resolve changes nothing.
    pending.resolve({ status: 'ok', preview: preview() })
    await Promise.resolve()
    expect(screen.queryByText('Sample Series')).not.toBeInTheDocument()
  })

  it('keeps showing the parts while the dialog animates closed', async () => {
    resolveWith({ status: 'ok', preview: preview() })
    const { onClose, rerender } = renderDialog()
    await screen.findByText('Sample Series')
    const popup = screen.getByRole('dialog')
    const content = popup.textContent
    const finishExit = holdExitAnimation(popup)
    await userEvent.click(screen.getByRole('button', { name: 'Cancel' }))
    expect(onClose).toHaveBeenCalled()
    rerender(null)
    await new Promise((r) => setTimeout(r, 0))
    expect(popup.textContent).toBe(content)
    expect(screen.queryByText(/Reading the page/)).not.toBeInTheDocument()
    await finishExit()
  })

  it('ignores the reply of a resolve the user moved away from', async () => {
    const first = deferred<ResolveMediaResult>()
    invokeMock.mockImplementation(async (channel: string, request: any) => {
      if (channel !== Commands.ResolveMedia) return { cancelled: true }
      if (request.url === PAGE) return first.promise
      return {
        status: 'ok',
        preview: preview({ title: 'Second Page' }),
      }
    })
    const { rerender } = renderDialog()
    rerender({ url: 'https://media.test/watch/2', pluginName: 'Example' })
    expect(await screen.findByText('Second Page')).toBeInTheDocument()
    first.resolve({
      status: 'ok',
      preview: preview({ title: 'Stale Page' }),
    })
    await new Promise((r) => setTimeout(r, 0))
    expect(screen.queryByText('Stale Page')).not.toBeInTheDocument()
    expect(screen.getByText('Second Page')).toBeInTheDocument()
  })

  it('preselects the pasted part and downloads its recommended quality', async () => {
    resolveWith({
      status: 'ok',
      preview: preview({
        entries: [
          entry(1, {
            variants: [
              variant('uhd', 2160, { locked: 'login' }),
              variant('hd', 1080, { recommended: true }),
              variant('sd', 480),
            ],
          }),
          entry(2),
        ],
      }),
    })
    const { onCreated } = renderDialog()
    expect(await screen.findByText('Sample Series')).toBeInTheDocument()
    expect(screen.getByRole('checkbox', { name: 'P1 Episode 1' })).toBeChecked()
    expect(
      screen.getByRole('checkbox', { name: 'P2 Episode 2' })
    ).not.toBeChecked()
    expect(screen.getByText('This page')).toBeInTheDocument()

    const quality = screen.getByLabelText('Quality') as HTMLSelectElement
    expect(quality.value).toBe('variant:hd')
    const locked = within(quality).getByRole('option', {
      name: '2160P (sign-in required)',
    }) as HTMLOptionElement
    expect(locked.disabled).toBe(true)
    expect(
      screen.getByText(
        'Sign in through the site resolver plugin’s settings to unlock more qualities.'
      )
    ).toBeInTheDocument()
    // One part needs no folder.
    expect(screen.queryByRole('switch')).not.toBeInTheDocument()

    await userEvent.selectOptions(quality, 'variant:sd')
    await userEvent.click(screen.getByRole('button', { name: 'Download (1)' }))

    await waitFor(() => expect(onCreated).toHaveBeenCalled())
    expect(createCalls()).toEqual([
      {
        ...base,
        uris: [PAGE],
        requestId: expect.any(String),
        mediaPick: {
          resolutionId: RESOLUTION,
          entryId: 'ep:1',
          variantId: 'sd',
        },
      },
    ])
    expect(onCreated).toHaveBeenCalledWith({ url: PAGE, firstTaskId: 'task' })
    expect(notify).toHaveBeenCalledWith('info', 'task.add.created')
  })

  it('saves several parts into the title folder by default with a shared height ceiling', async () => {
    resolveWith({
      status: 'ok',
      preview: preview({
        entries: [
          entry(1),
          entry(2, {
            variants: [variant('fhd', 1080), variant('md', 720)],
          }),
          entry(3, { unavailable: { reason: 'paid-content' } }),
        ],
      }),
    })
    const { onCreated } = renderDialog()
    await screen.findByText('Sample Series')
    expect(
      screen.getByText(
        'This media requires a membership or purchase on its site.'
      )
    ).toBeInTheDocument()
    expect(
      screen.getByRole('checkbox', { name: 'P3 Episode 3' })
    ).toHaveAttribute('aria-disabled', 'true')

    await userEvent.click(screen.getByRole('checkbox', { name: 'Select all' }))
    expect(screen.getByText('2 of 2 selected')).toBeInTheDocument()
    const folder = screen.getByRole('switch', {
      name: 'Save into folder “Sample Series”',
    })
    expect(folder).toBeChecked()

    const quality = screen.getByLabelText('Quality')
    expect(
      within(quality)
        .getAllByRole('option')
        .map((option) => option.textContent)
    ).toEqual(['Best available', 'Up to 1080P', 'Up to 720P', 'Up to 480P'])
    await userEvent.selectOptions(quality, 'height:720')
    await userEvent.click(screen.getByRole('button', { name: 'Download (2)' }))

    await waitFor(() => expect(onCreated).toHaveBeenCalled())
    const calls = createCalls()
    expect(calls.map((call) => call.mediaPick)).toEqual([
      {
        resolutionId: RESOLUTION,
        entryId: 'ep:1',
        maxHeight: 720,
        saveToFolder: true,
      },
      {
        resolutionId: RESOLUTION,
        entryId: 'ep:2',
        maxHeight: 720,
        saveToFolder: true,
      },
    ])
    expect(new Set(calls.map((call) => call.requestId)).size).toBe(2)
    expect(notify).toHaveBeenCalledWith('info', 'task.add.batchCreated', {
      count: 2,
    })
  })

  it('sends no folder when the user turns it off', async () => {
    resolveWith({ status: 'ok', preview: preview() })
    renderDialog()
    await screen.findByText('Sample Series')
    await userEvent.click(screen.getByRole('checkbox', { name: 'Select all' }))
    await userEvent.click(screen.getByRole('switch'))
    await userEvent.click(screen.getByRole('button', { name: 'Download (3)' }))
    await waitFor(() => expect(createCalls()).toHaveLength(3))
    for (const call of createCalls()) {
      expect(call.mediaPick).not.toHaveProperty('saveToFolder')
      expect(call.mediaPick).not.toHaveProperty('maxHeight')
    }
  })

  it('warns when more parts are picked than the preview allows without risk', async () => {
    resolveWith({
      status: 'ok',
      preview: preview({
        entries: Array.from({ length: 51 }, (_, i) => entry(i + 1)),
      }),
    })
    renderDialog()
    await screen.findByText('Sample Series')
    expect(screen.queryByText(/You picked/)).not.toBeInTheDocument()
    await userEvent.click(screen.getByRole('checkbox', { name: 'Select all' }))
    const warning = screen.getByText(/You picked 51 parts, more than 50\./, {
      selector: '[data-slot="alert-description"]',
    })
    // A warning, not a limit.
    expect(screen.getByRole('button', { name: 'Download (51)' })).toBeEnabled()
    // Announced once, politely, when the selection crosses the threshold;
    // later checkbox changes don't repeat it.
    expect(warning.closest('[role="alert"]')).toBeNull()
    const status = within(screen.getByRole('dialog')).getByRole('status')
    expect(status).toHaveTextContent(/You picked 51 parts/)
    await userEvent.click(
      screen.getByRole('checkbox', { name: 'P51 Episode 51' })
    )
    expect(status).toHaveTextContent(/You picked 51 parts/)
  })

  it('mounts only the visible rows of a long collection', async () => {
    // jsdom has no layout; give the list's scroller a real height.
    const clientHeight = vi
      .spyOn(HTMLElement.prototype, 'clientHeight', 'get')
      .mockImplementation(function (this: HTMLElement) {
        return this.dataset.testid === 'virtual-list-container' ? 280 : 0
      })
    onTestFinished(() => clientHeight.mockRestore())
    resolveWith({
      status: 'ok',
      preview: preview({
        entries: Array.from({ length: 300 }, (_, i) => entry(i + 1)),
      }),
    })
    renderDialog()
    await screen.findByText('Sample Series')
    const rows = within(
      screen.getByRole('list', { name: 'Parts' })
    ).getAllByRole('listitem')
    expect(rows.length).toBeGreaterThan(0)
    expect(rows.length).toBeLessThan(100)

    // Select all still covers the rows that aren't mounted.
    await userEvent.click(screen.getByRole('checkbox', { name: 'Select all' }))
    expect(screen.getByText('300 of 300 selected')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Download (300)' })).toBeEnabled()
  })

  it('keeps created parts and explains each failed one', async () => {
    const attempts = new Map<string, number>()
    invokeMock.mockImplementation(async (channel: string, request: any) => {
      if (channel === Commands.ResolveMedia)
        return { status: 'ok', preview: preview() }
      if (channel !== Commands.CreateTask) return { cancelled: true }
      const id: string = request.mediaPick.entryId
      const attempt = (attempts.get(id) ?? 0) + 1
      attempts.set(id, attempt)
      if (id === 'ep:2' && attempt === 1)
        throw new Error(
          "Error invoking remote method 'command:createTask': Error: task.add.media.failure.variantGone"
        )
      if (id === 'ep:3' && attempt === 1) throw new TypeError('Failed to fetch')
      return { gid: `gid-${id}` }
    })
    const { onCreated } = renderDialog()
    await screen.findByText('Sample Series')
    await userEvent.click(screen.getByRole('checkbox', { name: 'Select all' }))
    await userEvent.click(screen.getByRole('button', { name: 'Download (3)' }))

    const rows = await screen.findAllByRole('listitem')
    await waitFor(() =>
      expect(within(rows[0]).getByText('Added')).toBeInTheDocument()
    )
    expect(
      within(rows[1]).getByText(
        'The site resolver plugin no longer offers the part or quality you picked. Open the picker again and choose another.'
      )
    ).toBeInTheDocument()
    expect(
      within(rows[2]).getByText(/The result is unconfirmed/)
    ).toBeInTheDocument()
    expect(notify).toHaveBeenCalledWith('warn', 'task.add.createdPartial', {
      ok: 1,
      failed: 2,
    })
    expect(
      within(screen.getByRole('dialog')).getByRole('status')
    ).toHaveTextContent('1 added · 2 failed')
    expect(onCreated).not.toHaveBeenCalled()
    expect(
      screen.getByRole('checkbox', { name: 'P1 Episode 1' })
    ).toHaveAttribute('aria-disabled', 'true')

    const firstRound = createCalls()
    await userEvent.click(screen.getByRole('button', { name: 'Download (2)' }))
    await waitFor(() => expect(onCreated).toHaveBeenCalled())
    const retries = createCalls().slice(firstRound.length)
    expect(retries.map((call) => call.mediaPick?.entryId)).toEqual([
      'ep:2',
      'ep:3',
    ])
    // A rejected part is a new request; an unconfirmed one is checked again.
    expect(retries[0].requestId).not.toBe(firstRound[1].requestId)
    expect(retries[1].requestId).toBe(firstRound[2].requestId)
    expect(onCreated).toHaveBeenCalledWith({
      url: PAGE,
      firstTaskId: 'gid-ep:1',
    })
    expect(notify).toHaveBeenLastCalledWith('info', 'task.add.batchCreated', {
      count: 3,
    })
  })

  it('shows progress and stops a long pick after the current part', async () => {
    const first = deferred<unknown>()
    invokeMock.mockImplementation(async (channel: string, request: any) => {
      if (channel === Commands.ResolveMedia)
        return { status: 'ok', preview: preview() }
      if (channel !== Commands.CreateTask) return { cancelled: true }
      if (request.mediaPick.entryId === 'ep:1') return first.promise
      return { gid: `gid-${request.mediaPick.entryId}` }
    })
    const { onCreated } = renderDialog()
    await screen.findByText('Sample Series')
    await userEvent.click(screen.getByRole('checkbox', { name: 'Select all' }))
    await userEvent.click(screen.getByRole('button', { name: 'Download (3)' }))
    expect(
      await screen.findByRole('button', { name: 'Adding 1 of 3…' })
    ).toBeDisabled()

    await userEvent.click(screen.getByRole('button', { name: 'Stop' }))
    first.resolve({ gid: 'gid-ep:1' })
    expect(
      await screen.findByRole('button', { name: 'Download (2)' })
    ).toBeEnabled()
    expect(createCalls().map((call) => call.mediaPick?.entryId)).toEqual([
      'ep:1',
    ])
    expect(screen.getByRole('checkbox', { name: 'P2 Episode 2' })).toBeChecked()
    expect(screen.getByRole('checkbox', { name: 'P3 Episode 3' })).toBeChecked()
    expect(onCreated).not.toHaveBeenCalled()
    // A part was added, so leaving keeps it.
    expect(screen.getByRole('button', { name: 'Close' })).toBeEnabled()
  })

  it('loads the qualities of a deferred part when it is picked alone', async () => {
    const loaded = preview({
      entries: [entry(1), entry(2, { variants: [variant('q720', 720)] })],
    })
    resolveWith((request) =>
      request.entryIds
        ? { status: 'ok', preview: loaded }
        : {
            status: 'ok',
            preview: preview({
              entries: [entry(1), entry(2, { variants: null })],
            }),
          }
    )
    renderDialog()
    await screen.findByText('Sample Series')
    await userEvent.click(
      screen.getByRole('checkbox', { name: 'P1 Episode 1' })
    )
    await userEvent.click(
      screen.getByRole('checkbox', { name: 'P2 Episode 2' })
    )
    await waitFor(() =>
      expect(
        (screen.getByLabelText('Quality') as HTMLSelectElement).value
      ).toBe('variant:q720')
    )
    expect(invokeMock).toHaveBeenCalledWith(Commands.ResolveMedia, {
      requestId: expect.any(String),
      url: PAGE,
      resolutionId: RESOLUTION,
      entryIds: ['ep:2'],
    })
  })

  it('explains a part whose qualities turn out to be unavailable', async () => {
    resolveWith((request) =>
      request.entryIds
        ? {
            status: 'unavailable',
            pluginId: 'example.media-resolver',
            pluginName: 'Example Resolver',
            reason: 'drm',
          }
        : {
            status: 'ok',
            preview: preview({
              entries: [entry(1), entry(2, { variants: null })],
            }),
          }
    )
    renderDialog()
    await screen.findByText('Sample Series')
    await userEvent.click(
      screen.getByRole('checkbox', { name: 'P1 Episode 1' })
    )
    await userEvent.click(
      screen.getByRole('checkbox', { name: 'P2 Episode 2' })
    )
    expect(
      await screen.findByText(
        'This media is protected by DRM or encryption and can’t be downloaded.'
      )
    ).toBeInTheDocument()
    // Protected media stays protected however often it is read.
    expect(
      screen.queryByRole('button', { name: 'Retry' })
    ).not.toBeInTheDocument()
    expect(
      screen.queryByText('Couldn’t load the qualities of this part.')
    ).not.toBeInTheDocument()
    expect(
      screen.getByRole('checkbox', { name: 'P2 Episode 2' })
    ).toHaveAttribute('aria-disabled', 'true')
    expect(screen.getByRole('button', { name: 'Download (0)' })).toBeDisabled()
  })

  it('offers a height ceiling for parts whose qualities are not loaded yet', async () => {
    resolveWith({
      status: 'ok',
      preview: preview({
        entries: [
          entry(1),
          entry(2, { variants: null }),
          entry(3, { variants: null }),
        ],
      }),
    })
    renderDialog()
    await screen.findByText('Sample Series')
    await userEvent.click(
      screen.getByRole('checkbox', { name: 'P1 Episode 1' })
    )
    await userEvent.click(
      screen.getByRole('checkbox', { name: 'P2 Episode 2' })
    )
    await userEvent.click(
      screen.getByRole('checkbox', { name: 'P3 Episode 3' })
    )
    const quality = screen.getByLabelText('Quality')
    expect(
      within(quality)
        .getAllByRole('option')
        .map((option) => option.textContent)
    ).toEqual(['Best available', 'Up to 1080P', 'Up to 480P'])
    await userEvent.selectOptions(quality, 'height:480')
    await userEvent.click(screen.getByRole('button', { name: 'Download (2)' }))
    await waitFor(() => expect(createCalls()).toHaveLength(2))
    expect(createCalls().map((call) => call.mediaPick?.maxHeight)).toEqual([
      480, 480,
    ])
  })

  it('marks qualities that need the missing FFmpeg', async () => {
    resolveWith({
      status: 'ok',
      preview: preview({
        ffmpegAvailable: false,
        entries: [
          entry(1, {
            variants: [
              variant('mux', 1080, { requiresFfmpeg: true }),
              variant('direct', 360, { recommended: true }),
            ],
          }),
        ],
      }),
    })
    renderDialog()
    await screen.findByText('Sample Series')
    const quality = screen.getByLabelText('Quality') as HTMLSelectElement
    expect(quality.value).toBe('variant:direct')
    expect(
      (
        within(quality).getByRole('option', {
          name: '1080P (needs FFmpeg)',
        }) as HTMLOptionElement
      ).disabled
    ).toBe(true)
    expect(screen.getByText(/Some qualities need FFmpeg/)).toBeInTheDocument()
  })

  it('explains an unavailable page and offers it as a plain file', async () => {
    resolveWith({
      status: 'unavailable',
      pluginId: 'example.media-resolver',
      pluginName: 'Example Resolver',
      reason: 'login-required',
    })
    const { onCreated } = renderDialog()
    expect(
      await screen.findByText(
        'This media requires signing in. Sign in through the site resolver plugin’s settings, then try again.'
      )
    ).toBeInTheDocument()
    await userEvent.click(
      screen.getByRole('button', { name: 'Download page as a file' })
    )
    await waitFor(() => expect(onCreated).toHaveBeenCalled())
    expect(createCalls()).toEqual([
      {
        ...base,
        uris: [PAGE],
        requestId: expect.any(String),
        mediaResolve: 'skip',
      },
    ])
  })

  it('shows the resolver’s own message for an unknown reason', async () => {
    resolveWith({
      status: 'unavailable',
      pluginId: 'example.media-resolver',
      pluginName: 'Example Resolver',
      reason: 'age-gate',
      message: 'Confirm your age on the site first',
    })
    renderDialog()
    expect(
      await screen.findByText(
        'The site resolver plugin reports that this media can’t be downloaded: Confirm your age on the site first'
      )
    ).toBeInTheDocument()
  })

  it.each(['drm', 'encrypted'])(
    'never offers %s media as a plain file',
    async (reason) => {
      resolveWith({
        status: 'unavailable',
        pluginId: 'example.media-resolver',
        pluginName: 'Example Resolver',
        reason,
      })
      renderDialog()
      expect(
        await screen.findByText(
          'This media is protected by DRM or encryption and can’t be downloaded.'
        )
      ).toBeInTheDocument()
      expect(
        screen.queryByRole('button', { name: 'Download page as a file' })
      ).not.toBeInTheDocument()
      expect(
        screen.queryByRole('button', { name: 'Retry' })
      ).not.toBeInTheDocument()
    }
  )

  it('lets the user retry a failed resolve', async () => {
    let calls = 0
    resolveWith(() =>
      calls++ === 0
        ? {
            status: 'failed',
            pluginId: 'example.media-resolver',
            pluginName: 'Example Resolver',
            failure: 'timeout',
          }
        : { status: 'ok', preview: preview() }
    )
    renderDialog()
    expect(
      await screen.findByText(
        'The site resolver plugin didn’t respond in time. Try again later.'
      )
    ).toBeInTheDocument()
    expect(
      screen.getByRole('button', { name: 'Download page as a file' })
    ).toBeInTheDocument()
    await userEvent.click(screen.getByRole('button', { name: 'Retry' }))
    expect(await screen.findByText('Sample Series')).toBeInTheDocument()
  })

  it('asks for a save folder before creating anything', async () => {
    resolveWith({ status: 'ok', preview: preview() })
    renderDialog(undefined, {
      requestBase: () => ({
        ok: false,
        message: { key: 'task.add.errors.saveDirRequired' },
      }),
    })
    await screen.findByText('Sample Series')
    await userEvent.click(screen.getByRole('button', { name: 'Download (1)' }))
    expect(screen.getByText('Save directory is required')).toBeInTheDocument()
    expect(createCalls()).toHaveLength(0)
  })
})
