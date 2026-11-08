import { commands } from 'motrix:plugin-api'

// Pages look like https://media.test/watch/<case>?cdn=<encoded origin>; the
// streams live on the test's local fixture server at <origin>.
const PAGE = /^https:\/\/media\.test\/watch\/([a-z-]+)(?:\?cdn=([^&#]+))?$/
const REFERER = { Referer: 'https://media.test/' }

function media(title, entries) {
  return { kind: 'media', schemaVersion: 1, title, entries }
}

function direct(cdn) {
  return {
    id: 'sd',
    label: '360P',
    height: 360,
    container: 'mp4',
    source: {
      kind: 'direct',
      stream: { url: `${cdn}/clip.mp4`, headers: REFERER },
    },
  }
}

function hls(cdn) {
  return {
    id: 'hd',
    label: '1080P',
    height: 1080,
    container: 'ts',
    source: {
      kind: 'hls',
      manifest: { url: `${cdn}/hls/index.m3u8`, headers: REFERER },
    },
  }
}

commands.register('test.media-resolver.resolve', async (args) => {
  const match = PAGE.exec(args.url)
  if (!match) return null
  const cdn = match[2] ? decodeURIComponent(match[2]) : ''
  switch (match[1]) {
    case 'progressive':
      return media('Fixture clip', [
        { id: 'only', title: 'Fixture clip', variants: [direct(cdn)] },
      ])
    case 'adaptive':
      return media('Fixture clip', [
        {
          id: 'only',
          title: 'Fixture clip',
          variants: [hls(cdn), direct(cdn)],
        },
      ])
    case 'series': {
      const parts = [
        { id: 'p1', index: 1, title: 'Opening' },
        { id: 'p2', index: 2, title: 'Finale', current: true },
      ]
      // Variants are deferred until the host asks for specific entries.
      const wanted = args.entryIds ?? []
      return media(
        'Fixture series',
        parts.map((part) =>
          wanted.includes(part.id)
            ? { ...part, variants: [direct(`${cdn}/${part.id}`)] }
            : part
        )
      )
    }
    case 'members':
      return {
        kind: 'unavailable',
        reason: 'login-required',
        message: 'Members only',
      }
    case 'leaky':
      return media('Fixture clip', [
        {
          id: 'only',
          title: 'Fixture clip',
          variants: [
            {
              ...direct(cdn),
              source: {
                kind: 'direct',
                stream: {
                  url: `${cdn}/clip.mp4`,
                  headers: { Cookie: 'sid=1' },
                },
              },
            },
          ],
        },
      ])
    case 'legacy':
      return {
        kind: 'mux',
        title: 'Fixture legacy',
        container: 'mp4',
        video: {
          url: `${cdn}/video.m4s`,
          headers: { Referer: 'https://media.test/', Cookie: 'sid=1' },
        },
        audio: { url: `${cdn}/audio.m4s` },
      }
    default:
      return null
  }
})
