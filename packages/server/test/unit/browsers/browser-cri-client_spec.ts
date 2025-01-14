import { BrowserCriClient } from '../../../lib/browsers/browser-cri-client'
import * as CriClient from '../../../lib/browsers/cri-client'
import { expect, proxyquire, sinon } from '../../spec_helper'
import * as protocol from '../../../lib/browsers/protocol'
import { stripAnsi } from '@packages/errors'

const HOST = '127.0.0.1'
const PORT = 50505
const THROWS_PORT = 66666

describe('lib/browsers/cri-client', function () {
  let browserCriClient: {
    BrowserCriClient: {
      create: typeof BrowserCriClient.create
    }
  }
  let send: sinon.SinonStub
  let close: sinon.SinonStub
  let criClientCreateStub: sinon.SinonStub
  let criImport: sinon.SinonStub & {
    Version: sinon.SinonStub
  }
  let onError: sinon.SinonStub
  let getClient: () => ReturnType<typeof BrowserCriClient.create>

  beforeEach(function () {
    sinon.stub(protocol, '_connectAsync')

    criImport = sinon.stub()

    criImport.Version = sinon.stub()
    criImport.Version.withArgs({ host: HOST, port: PORT }).resolves({ webSocketDebuggerUrl: 'http://web/socket/url' })
    criImport.Version.withArgs({ host: HOST, port: THROWS_PORT })
    .onFirstCall().throws()
    .onSecondCall().throws()
    .onThirdCall().resolves({ webSocketDebuggerUrl: 'http://web/socket/url' })

    send = sinon.stub()
    close = sinon.stub()
    criClientCreateStub = sinon.stub(CriClient, 'create').withArgs('http://web/socket/url', onError).resolves({
      send,
      close,
    })

    browserCriClient = proxyquire('../lib/browsers/browser-cri-client', {
      'chrome-remote-interface': criImport,
    })

    getClient = () => browserCriClient.BrowserCriClient.create(PORT, 'Chrome', onError)
  })

  context('.create', function () {
    it('returns an instance of the Browser CRI client', async function () {
      const client = await getClient()

      expect(client.attachToNewUrl).to.be.instanceOf(Function)
    })

    it('throws an error when _connectAsync fails', async function () {
      (protocol._connectAsync as any).restore()
      sinon.stub(protocol, '_connectAsync').throws()

      await expect(getClient()).to.be.rejected
    })

    it('retries when Version fails', async function () {
      sinon.stub(protocol, '_getDelayMsForRetry')
      .onFirstCall().returns(100)
      .onSecondCall().returns(100)
      .onThirdCall().returns(100)

      const client = await browserCriClient.BrowserCriClient.create(THROWS_PORT, 'Chrome', onError)

      expect(client.attachToNewUrl).to.be.instanceOf(Function)

      expect(criImport.Version).to.be.calledThrice
    })

    it('throws when Version fails more than allowed', async function () {
      sinon.stub(protocol, '_getDelayMsForRetry')
      .onFirstCall().returns(100)
      .onSecondCall().returns(undefined)

      await expect(browserCriClient.BrowserCriClient.create(THROWS_PORT, 'Chrome', onError)).to.be.rejected

      expect(criImport.Version).to.be.calledTwice
    })

    context('#ensureMinimumProtocolVersion', function () {
      function withProtocolVersion (actual, test) {
        return getClient()
        .then((client: any) => {
          client.versionInfo = { 'Protocol-Version': actual }

          return client.ensureMinimumProtocolVersion(test)
        })
      }

      it('resolves if protocolVersion = current', function () {
        return expect(withProtocolVersion('1.3', '1.3')).to.be.fulfilled
      })

      it('resolves if protocolVersion > current', function () {
        return expect(withProtocolVersion('1.4', '1.3')).to.be.fulfilled
      })

      it('rejects if protocolVersion < current', function () {
        return expect(withProtocolVersion('1.2', '1.3')).to.be
        .rejected.then((err) => {
          expect(stripAnsi(err.message)).to.eq(`A minimum CDP version of 1.3 is required, but the current browser has 1.2.`)
        })
      })
    })

    context('#attachToTargetUrl', function () {
      it('creates a page client when the passed in url is found', async function () {
        const mockPageClient = {}

        send.withArgs('Target.getTargets').resolves({ targetInfos: [{ targetId: '1', url: 'http://foo.com' }, { targetId: '2', url: 'http://bar.com' }] })
        criClientCreateStub.withArgs('1', onError, HOST, PORT).resolves(mockPageClient)

        const browserClient = await getClient()

        const client = await browserClient.attachToTargetUrl('http://foo.com')

        expect(client).to.be.equal(mockPageClient)
      })

      it('retries when the passed in url is not found', async function () {
        sinon.stub(protocol, '_getDelayMsForRetry')
        .onFirstCall().returns(100)
        .onSecondCall().returns(100)
        .onThirdCall().returns(100)

        const mockPageClient = {}

        send.withArgs('Target.getTargets').resolves({ targetInfos: [{ targetId: '1', url: 'http://foo.com' }, { targetId: '2', url: 'http://bar.com' }] })
        send.withArgs('Target.getTargets').resolves({ targetInfos: [{ targetId: '1', url: 'http://foo.com' }, { targetId: '2', url: 'http://bar.com' }] })
        send.withArgs('Target.getTargets').resolves({ targetInfos: [{ targetId: '1', url: 'http://foo.com' }, { targetId: '2', url: 'http://bar.com' }, { targetId: '3', url: 'http://baz.com' }] })
        criClientCreateStub.withArgs('1', onError).resolves(mockPageClient)

        const browserClient = await getClient()

        const client = await browserClient.attachToTargetUrl('http://foo.com')

        expect(client).to.be.equal(mockPageClient)
      })

      it('throws when the passed in url is not found after retrying', async function () {
        sinon.stub(protocol, '_getDelayMsForRetry')
        .onFirstCall().returns(100)
        .onSecondCall().returns(undefined)

        const mockPageClient = {}

        send.withArgs('Target.getTargets').resolves({ targetInfos: [{ targetId: '1', url: 'http://foo.com' }, { targetId: '2', url: 'http://bar.com' }] })
        send.withArgs('Target.getTargets').resolves({ targetInfos: [{ targetId: '1', url: 'http://foo.com' }, { targetId: '2', url: 'http://bar.com' }] })
        criClientCreateStub.withArgs('1', onError).resolves(mockPageClient)

        const browserClient = await getClient()

        await expect(browserClient.attachToTargetUrl('http://baz.com')).to.be.rejected
      })
    })

    context('#attachToNewUrl', function () {
      it('creates new target and creates a page client with the passed in url', async function () {
        const mockPageClient = {}

        send.withArgs('Target.createTarget', { url: 'http://foo.com' }).resolves({ targetId: '10' })
        criClientCreateStub.withArgs('10', onError, HOST, PORT).resolves(mockPageClient)

        const browserClient = await getClient()

        const client = await browserClient.attachToNewUrl('http://foo.com')

        expect(client).to.be.equal(mockPageClient)
      })
    })

    context('#closeCurrentTarget', function () {
      it('closes the currently attached target', async function () {
        const mockCurrentlyAttachedTarget = {
          targetId: '100',
          close: sinon.stub().resolves(sinon.stub().resolves()),
        }

        send.withArgs('Target.closeTarget', { targetId: '100' }).resolves()

        const browserClient = await getClient() as any

        browserClient.currentlyAttachedTarget = mockCurrentlyAttachedTarget

        await browserClient.closeCurrentTarget()

        expect(mockCurrentlyAttachedTarget.close).to.be.called
      })

      it('throws when there is no currently attached target', async function () {
        const browserClient = await getClient() as any

        await expect(browserClient.closeCurrentTarget()).to.be.rejected
      })
    })

    context('#close', function () {
      it('closes the currently attached target if it exists and the browser client', async function () {
        const mockCurrentlyAttachedTarget = {
          close: sinon.stub().resolves(),
        }

        const browserClient = await getClient() as any

        browserClient.currentlyAttachedTarget = mockCurrentlyAttachedTarget

        await browserClient.close()

        expect(mockCurrentlyAttachedTarget.close).to.be.called
        expect(close).to.be.called
      })

      it('just the browser client with no currently attached target', async function () {
        const browserClient = await getClient() as any

        await browserClient.close()

        expect(close).to.be.called
      })
    })
  })
})
