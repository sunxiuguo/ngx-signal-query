import { Component, ErrorHandler, signal } from '@angular/core'
import { TestBed, fakeAsync, tick } from '@angular/core/testing'
import { type Observable, of, throwError } from 'rxjs'

import { mountHost } from '../../spec-helpers/host'
import {
  goOfflineAndBack,
  leaveAndComeBack,
  pinVisible,
  restoreVisibility,
} from '../../spec-helpers/page-events'
import { injectQuery } from './inject-query'
import { provideQueryClient } from './provider'
import { QueryClient } from './query-client'
import type { QueryOptions } from './types'

// A detail panel still alive during sign-out: its item disappears before
// Angular destroys the view. Capture the id in queryFn so the request itself
// remains valid even when the options callback can no longer read the item.
function mountPanel(
  request: (id: number) => Observable<string>,
  options: Partial<QueryOptions<string>> = {},
) {
  @Component({ template: '' })
  class Panel {
    readonly item = signal<{ id: number } | null>({ id: 1 })
    readonly query = injectQuery(() => {
      const id = this.item()!.id

      return {
        queryKey: ['item', id],
        queryFn: () => request(id),
        retry: false,
        ...options,
      }
    })
  }

  const fixture = TestBed.createComponent(Panel)

  fixture.detectChanges()

  return fixture
}

describe('query options that throw during sign-out', () => {
  let client: QueryClient

  beforeEach(() => {
    TestBed.configureTestingModule({ providers: [provideQueryClient()] })
    client = TestBed.inject(QueryClient)
  })

  beforeEach(pinVisible)
  afterEach(restoreVisibility)

  it('keeps retrying the original request and shares the server error', fakeAsync(() => {
    const serverError = new Error('server unavailable')
    const request = jasmine
      .createSpy('request')
      .and.returnValue(throwError(() => serverError))
    const fixture = mountPanel(request, { retry: 2, retryDelay: 100 })
    const query = client.getQueryCache().get(['item', 1])!

    expect(request).toHaveBeenCalledTimes(1)
    expect(query.state().failureReason).toBe(serverError)

    // During the first wait, sign-out invalidates the component's options.
    fixture.componentInstance.item.set(null)
    tick(100)

    expect(request).toHaveBeenCalledTimes(2)
    expect(query.state().failureReason).toBe(serverError)

    tick(100)

    expect(request.calls.allArgs()).toEqual([[1], [1], [1]])
    expect(query.state()).toEqual(
      jasmine.objectContaining({
        status: 'error',
        isFetching: false,
        failureCount: 3,
        failureReason: serverError,
        error: serverError,
      }),
    )
    expect(fixture.componentInstance.query.error()).toBe(serverError)
  }))

  it('retries through another component still showing the key', fakeAsync(() => {
    const serverError = new Error('server unavailable')
    const request = jasmine
      .createSpy('request')
      .and.returnValue(throwError(() => serverError))
    const fixture = mountPanel(request, { retry: 2, retryDelay: 100 })
    const validRequest = jasmine
      .createSpy('validRequest')
      .and.returnValue(of('recovered'))
    const valid = mountHost(() =>
      injectQuery(() => ({
        queryKey: ['item', 1],
        queryFn: validRequest,
      })),
    )

    // Joining makes validRequest the fallback. Replace that fallback so
    // success must come from selecting the live observer, past the bad one.
    void client.fetchQuery(['item', 1], () => request(1))
    fixture.componentInstance.item.set(null)
    tick(100)

    expect(request).toHaveBeenCalledTimes(1)
    expect(validRequest).toHaveBeenCalledTimes(1)
    expect(valid.created.data()).toBe('recovered')
    expect(valid.created.error()).toBeNull()
    expect(valid.created.failureReason()).toBeNull()
  }))

  for (const method of ['invalidateQueries', 'refetchQueries'] as const) {
    it(`${method} skips the broken component and refetches other queries`, fakeAsync(() => {
      const request = jasmine.createSpy('request').and.returnValue(of('item'))
      const fixture = mountPanel(request)
      const otherRequest = jasmine
        .createSpy('otherRequest')
        .and.returnValue(of('other'))

      mountHost(() =>
        injectQuery(() => ({ queryKey: ['other'], queryFn: otherRequest })),
      )
      fixture.componentInstance.item.set(null)

      let completed = false

      expect(() => {
        void client[method]().then(() => {
          completed = true
        })
      }).not.toThrow()
      tick()

      expect(completed).toBe(true)
      expect(request).toHaveBeenCalledTimes(1)
      expect(otherRequest).toHaveBeenCalledTimes(2)
    }))

    it(`${method} uses another valid observer of the same key`, fakeAsync(() => {
      const request = jasmine.createSpy('request').and.returnValue(of('item'))
      const fixture = mountPanel(request)
      const validRequest = jasmine
        .createSpy('validRequest')
        .and.returnValue(of('fresh'))

      mountHost(() =>
        injectQuery(() => ({ queryKey: ['item', 1], queryFn: validRequest })),
      )
      validRequest.calls.reset()
      fixture.componentInstance.item.set(null)

      expect(() => {
        void client[method]()
      }).not.toThrow()
      tick()

      expect(request).toHaveBeenCalledTimes(1)
      expect(validRequest).toHaveBeenCalledTimes(1)
      expect(client.getQueryData(['item', 1])).toBe('fresh')
    }))
  }

  for (const [event, dispatch] of [
    ['focus', leaveAndComeBack],
    ['reconnect', goOfflineAndBack],
  ] as const) {
    it(`${event} skips the broken component, then refetches valid observers and other queries`, fakeAsync(() => {
      const request = jasmine.createSpy('request').and.returnValue(of('item'))
      const fixture = mountPanel(request)
      const otherRequest = jasmine
        .createSpy('otherRequest')
        .and.returnValue(of('other'))

      mountHost(() =>
        injectQuery(() => ({ queryKey: ['other'], queryFn: otherRequest })),
      )
      fixture.componentInstance.item.set(null)

      expect(dispatch).not.toThrow()
      // RxJS reports listener errors on a later task: dispatch alone cannot
      // prove that there was no uncaught error from the browser event.
      tick()

      expect(request).toHaveBeenCalledTimes(1)
      expect(otherRequest).toHaveBeenCalledTimes(2)

      const validRequest = jasmine
        .createSpy('validRequest')
        .and.returnValue(of('fresh'))

      mountHost(() =>
        injectQuery(() => ({ queryKey: ['item', 1], queryFn: validRequest })),
      )
      validRequest.calls.reset()

      expect(dispatch).not.toThrow()
      tick()

      expect(validRequest).toHaveBeenCalledTimes(1)
      expect(otherRequest).toHaveBeenCalledTimes(3)
      expect(client.getQueryData(['item', 1])).toBe('fresh')
    }))
  }

  it('skips polls while options throw and resumes when the item returns', fakeAsync(() => {
    const request = jasmine.createSpy('request').and.returnValue(of('item'))
    const fixture = mountPanel(request, { refetchInterval: 100 })

    fixture.componentInstance.item.set(null)

    expect(() => tick(300)).not.toThrow()
    expect(request).toHaveBeenCalledTimes(1)

    fixture.componentInstance.item.set({ id: 1 })
    tick(100)

    expect(request).toHaveBeenCalledTimes(2)

    fixture.destroy()
  }))

  it('still skips disabled and changed-key observers alongside a broken one', fakeAsync(() => {
    const fixture = mountPanel(() => of('item'))
    const disabledRequest = jasmine
      .createSpy('disabledRequest')
      .and.returnValue(of('disabled'))
    const movedRequest = jasmine
      .createSpy('movedRequest')
      .and.returnValue(of('moved'))
    const id = signal(1)

    mountHost(() =>
      injectQuery(() => ({
        queryKey: ['disabled'],
        queryFn: disabledRequest,
        enabled: false,
      })),
    )
    mountHost(() =>
      injectQuery(() => ({
        queryKey: ['moved', id()],
        queryFn: movedRequest,
      })),
    )
    fixture.componentInstance.item.set(null)
    id.set(2)

    // None of these background paths should reuse the old key's observer
    // before change detection switches it to the new key.
    void client.invalidateQueries()
    void client.refetchQueries()
    leaveAndComeBack()
    goOfflineAndBack()
    tick()

    expect(disabledRequest).not.toHaveBeenCalled()
    expect(movedRequest).toHaveBeenCalledTimes(1)
    expect(client.getQueryData(['moved', 1])).toBe('moved')
    expect(client.getQueryData(['moved', 2])).toBeUndefined()
  }))

  it('still reports the component effect error through Angular ErrorHandler', fakeAsync(() => {
    const handleError = jasmine.createSpy('handleError')

    // Let Angular's scheduler run change detection and report its error.
    // Disable TestBed's extra rethrow so the handler's calls can be inspected.
    TestBed.resetTestingModule()
    TestBed.configureTestingModule({
      providers: [
        provideQueryClient(),
        { provide: ErrorHandler, useValue: { handleError } },
      ],
      rethrowApplicationErrors: false,
    })

    const fixture = mountPanel(() => of('item'))
    const currentClient = TestBed.inject(QueryClient)

    fixture.autoDetectChanges()
    fixture.componentInstance.item.set(null)

    expect(() => {
      void currentClient.invalidateQueries()
    }).not.toThrow()
    tick()

    expect(handleError).toHaveBeenCalledWith(jasmine.any(TypeError))
  }))
})
