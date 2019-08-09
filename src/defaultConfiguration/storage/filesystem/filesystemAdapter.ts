// Modified code from https://github.com/panva/node-oidc-provider/blob/master/example/adapters/redis.js

import Redis from 'ioredis'
import { isEmpty } from 'lodash'
import { Adapter } from 'oidc-provider'

const REDIS_URL = process.env.REDIS_URL || ''

const consumable = new Set([
  'AuthorizationCode',
  'RefreshToken',
  'DeviceCode'
])

function grantKeyFor (id) {
  return `grant:${id}`
}

function userCodeKeyFor (userCode) {
  return `userCode:${userCode}`
}

function uidKeyFor (uid) {
  return `uid:${uid}`
}

export default class FilesystemAdapter implements Adapter {
  name: string
  client: Redis

  constructor (name: string) {
    this.name = name
    this.client = new Redis(REDIS_URL, { keyPrefix: 'oidc:' })
  }

  async upsert (id: string, payload, expiresIn: number): Promise<void> {
    const key = this.key(id)
    const store = consumable.has(this.name)
      ? { payload: JSON.stringify(payload) } : JSON.stringify(payload)

    const multi = this.client.multi()
    multi[consumable.has(this.name) ? 'hmset' : 'set'](key, store)

    if (expiresIn) {
      multi.expire(key, expiresIn)
    }

    if (payload.grantId) {
      const grantKey = grantKeyFor(payload.grantId)
      multi.rpush(grantKey, key)
      // if you're seeing grant key lists growing out of acceptable proportions consider using LTRIM
      // here to trim the list to an appropriate length
      const ttl = await this.client.ttl(grantKey)
      if (expiresIn > ttl) {
        multi.expire(grantKey, expiresIn)
      }
    }

    if (payload.userCode) {
      const userCodeKey = userCodeKeyFor(payload.userCode)
      multi.set(userCodeKey, id)
      multi.expire(userCodeKey, expiresIn)
    }

    if (payload.uid) {
      const uidKey = uidKeyFor(payload.uid)
      multi.set(uidKey, id)
      multi.expire(uidKey, expiresIn)
    }

    await multi.exec()
  }

  async find (id) {
    const data = consumable.has(this.name)
      ? await this.client.hgetall(this.key(id))
      : await this.client.get(this.key(id))

    if (isEmpty(data)) {
      return undefined
    }

    if (typeof data === 'string') {
      return JSON.parse(data)
    }
    const { payload, ...rest } = data
    return {
      ...rest,
      ...JSON.parse(payload)
    }
  }

  async findByUid (uid) {
    const id = await this.client.get(uidKeyFor(uid))
    return this.find(id)
  }

  async findByUserCode (userCode) {
    const id = await this.client.get(userCodeKeyFor(userCode))
    return this.find(id)
  }

  async destroy (id) {
    const key = this.key(id)
    await this.client.del(key)
  }

  async revokeByGrantId (grantId) { // eslint-disable-line class-methods-use-this
    const multi = this.client.multi()
    const tokens = await this.client.lrange(grantKeyFor(grantId), 0, -1)
    tokens.forEach(token => multi.del(token))
    multi.del(grantKeyFor(grantId))
    await multi.exec()
  }

  async consume (id) {
    await this.client.hset(this.key(id), 'consumed', Math.floor(Date.now() / 1000))
  }

  key (id) {
    return `${this.name}:${id}`
  }
}
