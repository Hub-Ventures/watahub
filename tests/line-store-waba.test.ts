import { describe, expect, it } from 'vitest'
import { DistributedLineStore, MemoryLineStore, type KeyValueStore, type LineStore } from '../src/index.js'

/** Both core stores implement the optional lookup */
type WabaLineStore = Required<LineStore>

interface RecordedSet {
  key: string
  value: string
  options?: { ttlSeconds?: number }
}

class MapKv implements KeyValueStore {
  readonly map = new Map<string, string>()
  readonly sets: RecordedSet[] = []

  get(key: string): Promise<string | null> {
    return Promise.resolve(this.map.get(key) ?? null)
  }

  set(key: string, value: string, options?: { ttlSeconds?: number }): Promise<void> {
    this.sets.push({ key, value, options })
    this.map.set(key, value)
    return Promise.resolve()
  }
}

const stores: Array<[string, () => WabaLineStore]> = [
  ['MemoryLineStore', () => new MemoryLineStore()],
  ['DistributedLineStore', () => new DistributedLineStore(new MapKv())],
]

describe.each(stores)('%s.findByWaba', (_name, createStore) => {
  it('misses a WABA with no line', async () => {
    const store = createStore()
    expect(await store.findByWaba('200')).toBeUndefined()
    await store.put({ phoneNumberId: '100', wabaId: '200', accessToken: 'BIZ' })
    expect(await store.findByWaba('201')).toBeUndefined()
  })

  it('returns the line last put for a WABA', async () => {
    const store = createStore()
    await store.put({ phoneNumberId: '100', wabaId: '200', accessToken: 'BIZ_FIRST' })
    expect(await store.findByWaba('200')).toEqual({ phoneNumberId: '100', wabaId: '200', accessToken: 'BIZ_FIRST' })

    await store.put({ phoneNumberId: '101', wabaId: '200', accessToken: 'BIZ_LAST' })
    expect(await store.findByWaba('200')).toEqual({ phoneNumberId: '101', wabaId: '200', accessToken: 'BIZ_LAST' })
    // The first line keeps its own token for calls that name it
    expect(await store.get('100')).toEqual({ phoneNumberId: '100', wabaId: '200', accessToken: 'BIZ_FIRST' })
  })

  it('misses when the line it pointed to was put again under another WABA', async () => {
    const store = createStore()
    await store.put({ phoneNumberId: '100', wabaId: '200', accessToken: 'BIZ_OLD' })
    await store.put({ phoneNumberId: '100', wabaId: '300', accessToken: 'BIZ_NEW' })
    expect(await store.findByWaba('200')).toBeUndefined()
    expect(await store.findByWaba('300')).toEqual({ phoneNumberId: '100', wabaId: '300', accessToken: 'BIZ_NEW' })
  })
})

describe('DistributedLineStore WABA pointer', () => {
  it('writes the line first, then a pointer that holds the phone number ID and never the token', async () => {
    const kv = new MapKv()
    await new DistributedLineStore(kv).put({ phoneNumberId: '100', wabaId: '200', accessToken: 'BIZ' })
    expect(kv.sets).toEqual([
      {
        key: 'watahub:line:100',
        value: JSON.stringify({ phoneNumberId: '100', wabaId: '200', accessToken: 'BIZ' }),
        options: undefined,
      },
      { key: 'watahub:line:waba:200', value: '100', options: undefined },
    ])
    expect(kv.sets[1].value).not.toContain('BIZ')
  })

  it('keeps the pointer under the store prefix', async () => {
    const kv = new MapKv()
    const store = new DistributedLineStore(kv, 'tenant-a:')
    await store.put({ phoneNumberId: '100', wabaId: '200', accessToken: 'BIZ' })
    expect([...kv.map.keys()]).toEqual(['tenant-a:100', 'tenant-a:waba:200'])
    expect(await store.findByWaba('200')).toEqual({ phoneNumberId: '100', wabaId: '200', accessToken: 'BIZ' })
  })

  it.each([
    ['empty', ''],
    ['not numeric', 'not-a-number'],
    ['a path', '100/../waba:200'],
    ['another pointer key', 'waba:200'],
    ['JSON', JSON.stringify({ phoneNumberId: '100' })],
  ])('treats a malformed pointer (%s) as a miss without reading another key', async (_label, pointer) => {
    const kv = new MapKv()
    const store = new DistributedLineStore(kv)
    await store.put({ phoneNumberId: '100', wabaId: '200', accessToken: 'BIZ' })
    kv.map.set('watahub:line:waba:200', pointer)
    const reads: string[] = []
    const watched: KeyValueStore = {
      get: (key) => {
        reads.push(key)
        return kv.get(key)
      },
      set: (key, value, options) => kv.set(key, value, options),
    }
    expect(await new DistributedLineStore(watched).findByWaba('200')).toBeUndefined()
    expect(reads).toEqual(['watahub:line:waba:200'])
  })

  it('treats a pointer to a missing or malformed line as a miss', async () => {
    const kv = new MapKv()
    const store = new DistributedLineStore(kv)

    kv.map.set('watahub:line:waba:200', '100')
    expect(await store.findByWaba('200')).toBeUndefined()

    kv.map.set('watahub:line:100', 'not-json')
    expect(await store.findByWaba('200')).toBeUndefined()

    kv.map.set('watahub:line:100', JSON.stringify({ phoneNumberId: '999', wabaId: '200', accessToken: 'BIZ' }))
    expect(await store.findByWaba('200')).toBeUndefined()

    kv.map.set('watahub:line:100', JSON.stringify({ phoneNumberId: '100', wabaId: '200', accessToken: '' }))
    expect(await store.findByWaba('200')).toBeUndefined()

    kv.map.set('watahub:line:100', JSON.stringify({ phoneNumberId: '100', wabaId: '200', accessToken: 'BIZ' }))
    expect(await store.findByWaba('200')).toEqual({ phoneNumberId: '100', wabaId: '200', accessToken: 'BIZ' })
  })
})
