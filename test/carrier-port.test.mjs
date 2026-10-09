// 第十七轮（2026-10-05）：端口选择的公开契约。
//
// 这一层之所以单独测：真机上用户遇到的那句死路（"调试端口上有另一台浏览器，请先手动关闭再
// Get"）就是这段判断写出来的。三条规矩必须钉住 ——
//   1) 别人的浏览器只是"往下一跳"的理由，不是整次失败的理由；
//   2) 我们自己的实例才允许被认领（认领 = 交给 closer 按身份关，不是"看到专属目录就抢"）；
//   3) 一次点击的探测次数由端口范围本身封顶（没有重试、没有无界扫描），而且第一个空闲端口
//      之后不再探测 —— 否则一次点击要花十几秒去证明上面的端口都忙。
import test from 'node:test'
import assert from 'node:assert/strict'

import { carrierPortNote, pickCarrierPort } from '../lib/core.js'

const quiet = () => ({ ok: false, running: false })
const answers = (browserId) => ({ ok: true, running: true, browserId })

test('the first quiet port wins, and nothing above it is probed', async () => {
  const probed = []
  const pick = await pickCarrierPort({
    start: 9333,
    end: 9343,
    ours: ['uuid-ours'],
    probe: async (port) => { probed.push(port); return quiet() },
  })
  assert.deepEqual(probed, [9333], '空闲端口之上一个都不探：一次点击不能花十几秒证明上面都忙')
  assert.equal(pick.ok, true)
  assert.equal(pick.port, 9333)
  assert.equal(pick.claim, null)
  assert.equal(pick.probes, 1)
})

test('a stranger below is recorded, and the run moves past it instead of failing', async () => {
  const pick = await pickCarrierPort({
    start: 9333,
    end: 9343,
    ours: ['uuid-ours'],
    probe: async (port) => (port === 9333 ? answers('uuid-someone-else') : quiet()),
  })
  assert.equal(pick.ok, true, '别人占着 9333 不是整次失败的理由')
  assert.equal(pick.port, 9334, '换一条端口继续')
  assert.deepEqual(pick.strangers, [{ port: 9333, id: 'uuid-someone-else' }], '陌生人被具名记下')
  assert.equal(pick.probes, 2)
})

test('our own instance is claimed where it stands, and the scan stops there', async () => {
  const probed = []
  const pick = await pickCarrierPort({
    start: 9333,
    end: 9343,
    ours: ['uuid-ours'],
    probe: async (port) => { probed.push(port); return port === 9333 ? answers('UUID-OURS') : quiet() },
  })
  assert.equal(pick.claim && pick.claim.port, 9333, '身份对得上就认领（大小写归一之后比）')
  assert.equal(pick.claim.id, 'uuid-ours')
  assert.equal(pick.port, 0, '认领时 port 是 0：认领不等于可以直接用那条端口')
  assert.deepEqual(probed, [9333], '认领之后不再继续扫（认领关不掉时由调用方带 skip 再扫一趟）')
})

test('the caller can retire a port from consideration', async () => {
  const probed = []
  const pick = await pickCarrierPort({
    start: 9333,
    end: 9343,
    ours: [],
    skip: [9333, 9334],
    probe: async (port) => { probed.push(port); return quiet() },
  })
  assert.deepEqual(probed, [9335], 'skip 里的端口一次都不探')
  assert.equal(pick.port, 9335)
  assert.equal(pick.probes, 1)
})

test('a port that answers without an identity is occupied, not free', async () => {
  const pick = await pickCarrierPort({
    start: 9333,
    end: 9343,
    ours: ['uuid-ours'],
    probe: async (port) => (port === 9333 ? { ok: false, running: true, reason: 'no-target' } : quiet()),
  })
  assert.equal(pick.port, 9334)
  assert.deepEqual(pick.strangers, [{ port: 9333, id: '' }], '认不出身份的也算占着：不许在陌生人旁边起浏览器')
})

test('nothing is ever claimed when no identity of ours is on record', async () => {
  const pick = await pickCarrierPort({
    start: 9333,
    end: 9343,
    ours: [],
    probe: async (port) => (port === 9333 ? answers('uuid-ours') : quiet()),
  })
  assert.equal(pick.claim, null, '认出"看着像我们的"不算证据：只有身份对得上才认领')
  assert.equal(pick.port, 9334)
  assert.equal(pick.strangers.length, 1)
})

test('a probe that throws is a reading, not the end of the scan', async () => {
  const pick = await pickCarrierPort({
    start: 9333,
    end: 9343,
    ours: [],
    probe: async (port) => {
      if (port === 9333) throw new Error('socket hang up')
      return quiet()
    },
  })
  assert.equal(pick.port, 9334)
  assert.equal(pick.errors.length, 1)
  assert.match(pick.errors[0], /^9333: socket hang up$/, '"探测失败"和"有人在那儿"是两种读数，必须分开说')
  assert.equal(pick.probes, 2)
})

test('the whole range answering ends in one bounded failure with the count', async () => {
  let calls = 0
  const pick = await pickCarrierPort({
    start: 9333,
    end: 9335,
    ours: ['uuid-ours'],
    probe: async () => { calls += 1; return answers('uuid-stranger') },
  })
  assert.equal(pick.ok, false)
  assert.equal(pick.reason, 'no-debug-port')
  assert.equal(calls, 3, '探测次数由端口范围封顶：没有重试循环')
  assert.equal(pick.probes, 3)
  assert.equal(pick.strangers.length, 3)
})

test('without a probe function the picker refuses instead of guessing', async () => {
  const pick = await pickCarrierPort({ start: 9333, end: 9343, ours: [] })
  assert.equal(pick.ok, false)
  assert.equal(pick.reason, 'no-probe')
  assert.equal(pick.probes, 0)
})

test('the sentence names the stranger, the port it moved to, and what it did not touch', () => {
  const note = carrierPortNote({ used: 9334, strangers: [{ port: 9333, id: 'uuid-x' }] })
  assert.match(note, /9333/)
  assert.match(note, /uuid-x/)
  assert.match(note, /9334/)
  assert.match(note, /独立临时 profile/)
  assert.match(note, /没有读也没有动它/)
  assert.ok(!/先手动关掉/.test(note), '这句话本身就是那个死路的来源，绝不许回来')
  assert.ok(!/请.*关闭/.test(note))
})

test('a leftover of ours that would not close is named with its reason, and the stop script is still the way', () => {
  const note = carrierPortNote({
    used: 9334,
    strangers: [],
    claim: { port: 9333, id: 'uuid-left' },
    claimWhy: 'still-running',
  })
  assert.match(note, /9333/)
  assert.match(note, /uuid-left/)
  assert.match(note, /still-running/)
  assert.match(note, /9334/)
  assert.match(note, /没有读它/)
  assert.match(note, /停止脚本/)
})

test('a shared profile that is already held is named, and so is a leftover we did close', () => {
  const held = carrierPortNote({ used: 9334, strangers: [], isolateWhy: 'shared-profile-held' })
  assert.match(held, /共享 profile 已被另一台浏览器占着/)
  assert.match(held, /9334/)
  assert.match(held, /不影响那一台/)
  const again = carrierPortNote({ used: 9333, strangers: [], claim: { port: 9333, id: 'uuid-left' } })
  assert.match(again, /已确证关闭，本次沿用它/)
  assert.equal(carrierPortNote({ used: 9333, strangers: [] }), '', '什么都没绕过去时不留废话')
  assert.equal(carrierPortNote({}), '')
})
