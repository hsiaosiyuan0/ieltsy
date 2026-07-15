(() => {
  document.documentElement.classList.add('has-js')

  const storage = {
    get(key) {
      try { return window.localStorage.getItem(key) } catch { return null }
    },
    set(key, value) {
      try { window.localStorage.setItem(key, value) } catch {}
    },
  }

  const liveRegion = document.querySelector('[data-reader-status]')
  const audioCache = new Map()
  let playbackToken = 0
  let currentAudio = null
  let stopCurrent = null
  let activeSentence = null
  const scrollbarTimers = new WeakMap()

  function revealScrollbar(element) {
    element.classList.add('is-scrolling')
    const previous = scrollbarTimers.get(element)
    if (previous) window.clearTimeout(previous)
    const timer = window.setTimeout(() => {
      element.classList.remove('is-scrolling')
      scrollbarTimers.delete(element)
    }, 700)
    scrollbarTimers.set(element, timer)
  }

  window.addEventListener('scroll', () => revealScrollbar(document.documentElement), { passive: true })
  document.querySelectorAll('.annotation-panel').forEach((panel) => {
    panel.addEventListener('scroll', () => revealScrollbar(panel), { passive: true })
  })

  function announce(message) {
    if (liveRegion) liveRegion.textContent = message
  }

  function setPressed(action, pressed) {
    document.querySelectorAll('[data-action="' + action + '"]').forEach((control) => {
      control.setAttribute('aria-pressed', String(pressed))
    })
  }

  function setDisabled(action, disabled) {
    document.querySelectorAll('[data-action="' + action + '"]').forEach((control) => {
      if (control instanceof HTMLButtonElement) control.disabled = disabled
      control.setAttribute('aria-disabled', String(disabled))
    })
  }

  function syncSentenceAnswerControl(sentence) {
    if (!(sentence instanceof HTMLElement)) return
    const control = sentence.querySelector('[data-action="toggle-sentence-answer"]')
    if (!(control instanceof HTMLButtonElement)) return
    const visible = sentence.classList.contains('dictation-answer-visible')
    const number = sentence.getAttribute('data-number') || ''
    const label = (visible ? '隐藏' : '显示') + '第 ' + number + ' 句英文'
    control.setAttribute('aria-expanded', String(visible))
    control.setAttribute('aria-label', label)
    control.title = visible ? '隐藏英文' : '显示英文'
  }

  function resetSentenceAnswers() {
    document.querySelectorAll('.sentence').forEach((sentence) => {
      sentence.classList.remove('dictation-answer-visible')
      syncSentenceAnswerControl(sentence)
    })
  }

  function setActiveSentence(sentence) {
    if (activeSentence) activeSentence.classList.remove('is-playing')
    activeSentence = sentence instanceof HTMLElement ? sentence : null
    if (activeSentence) activeSentence.classList.add('is-playing')
  }

  function setPlayAllState(playing) {
    setPressed('play-all', playing)
    const button = document.querySelector('[data-action="play-all"]')
    if (button) button.setAttribute('aria-label', playing ? '停止全文朗读' : '朗读全文')
  }

  function cancelPlayback() {
    playbackToken += 1
    if (currentAudio) {
      currentAudio.pause()
      try { currentAudio.currentTime = 0 } catch {}
    }
    if (stopCurrent) stopCurrent()
    if ('speechSynthesis' in window) window.speechSynthesis.cancel()
    currentAudio = null
    stopCurrent = null
    setActiveSentence(null)
    setPlayAllState(false)
  }

  function getAudio(src) {
    if (audioCache.has(src)) return audioCache.get(src)
    const audio = new Audio(src)
    audio.preload = 'auto'
    audioCache.set(src, audio)
    return audio
  }

  function browserSpeak(text, token) {
    return new Promise((resolve) => {
      if (!text || token !== playbackToken || !('speechSynthesis' in window) || !('SpeechSynthesisUtterance' in window)) {
        resolve()
        return
      }

      window.speechSynthesis.cancel()
      const utterance = new SpeechSynthesisUtterance(text)
      utterance.lang = 'en-US'
      utterance.rate = 0.9
      utterance.onend = resolve
      utterance.onerror = resolve
      window.speechSynthesis.speak(utterance)
    })
  }

  function playOne(item, token) {
    const text = item.text || ''
    const src = item.audio || ''
    if (!text || token !== playbackToken) return Promise.resolve()

    setActiveSentence(item.sentence)
    if (item.number) announce('正在朗读第 ' + item.number + ' 句')

    if (!src) {
      if (item.requireAudio) {
        announce('句子音频不可用，已停止朗读')
        if (token === playbackToken) setActiveSentence(null)
        return Promise.resolve()
      }
      return browserSpeak(text, token).finally(() => {
        if (token === playbackToken) setActiveSentence(null)
      })
    }

    return new Promise((resolve) => {
      const audio = getAudio(src)
      let settled = false

      function clear() {
        audio.onended = null
        audio.onerror = null
        if (currentAudio === audio) currentAudio = null
        if (stopCurrent === finish) stopCurrent = null
      }

      function finish() {
        if (settled) return
        settled = true
        clear()
        if (token === playbackToken) setActiveSentence(null)
        resolve()
      }

      function fallback() {
        if (settled) return
        clear()
        if (item.requireAudio) {
          announce('句子音频加载失败，已停止朗读')
          finish()
          return
        }
        browserSpeak(text, token).then(finish)
      }

      currentAudio = audio
      stopCurrent = finish
      audio.onended = finish
      audio.onerror = fallback
      try { audio.currentTime = 0 } catch {}
      audio.play().catch(fallback)
    })
  }

  function speak(item) {
    if (!item.text) return
    cancelPlayback()
    const token = playbackToken
    void playOne(item, token)
  }

  function playSequence(items) {
    cancelPlayback()
    const token = playbackToken
    setPlayAllState(true)
    announce('开始全文朗读')

    void (async () => {
      for (const item of items) {
        if (token !== playbackToken) return
        await playOne(item, token)
      }
      if (token === playbackToken) {
        setPlayAllState(false)
        setActiveSentence(null)
        announce('全文朗读完成')
      }
    })()
  }

  function syncViewControls() {
    const dictation = document.body.classList.contains('dictation-mode')
    setPressed('toggle-zh', dictation || !document.body.classList.contains('hide-zh'))
    setPressed('toggle-follow', !dictation && !document.body.classList.contains('hide-follow'))
    setPressed('toggle-practice', !dictation && document.body.classList.contains('practice'))
    setPressed('toggle-dictation', dictation)
    for (const action of ['play-all', 'toggle-zh', 'toggle-follow', 'toggle-practice']) {
      setDisabled(action, dictation)
    }
    const dictationButton = document.querySelector('[data-action="toggle-dictation"]')
    if (dictationButton) {
      dictationButton.setAttribute('aria-label', dictation ? '退出中译英默写模式' : '开启中译英默写模式')
    }
  }

  function initializeLessonState() {
    if (!document.body.matches('[data-page="lesson"]')) return

    if (storage.get('ieltsy:show-zh') === '1') document.body.classList.remove('hide-zh')
    else document.body.classList.add('hide-zh')

    if (storage.get('ieltsy:show-follow') === '0') document.body.classList.add('hide-follow')
    else document.body.classList.remove('hide-follow')

    if (storage.get('ieltsy:practice') === '1') document.body.classList.add('practice')
    else document.body.classList.remove('practice')

    if (storage.get('ieltsy:dictation') === '1') document.body.classList.add('dictation-mode')
    else document.body.classList.remove('dictation-mode')

    resetSentenceAnswers()
    syncViewControls()
  }

  function initializeGrammarLibrary() {
    const input = document.querySelector('[data-grammar-search]')
    const entries = Array.from(document.querySelectorAll('[data-grammar-entry]'))
    const chapters = Array.from(document.querySelectorAll('[data-grammar-chapter]'))
    const filters = Array.from(document.querySelectorAll('[data-grammar-filter]'))
    const results = document.querySelector('[data-grammar-results]')
    const empty = document.querySelector('[data-grammar-empty]')
    if (!(input instanceof HTMLInputElement) || entries.length === 0) return

    let activeFilter = 'all'

    function applyFilters() {
      const query = input.value.normalize('NFKC').trim().toLocaleLowerCase('zh-CN')
      let visibleCount = 0

      for (const entry of entries) {
        const searchable = entry.getAttribute('data-search') || ''
        const matchesQuery = !query || searchable.includes(query)
        const matchesFilter = activeFilter === 'all'
          || (activeFilter === 'priority' && entry.getAttribute('data-importance') === '3')
          || (activeFilter === 'notes' && entry.getAttribute('data-note') === 'true')
        entry.hidden = !(matchesQuery && matchesFilter)
        if (!entry.hidden) visibleCount += 1
      }

      for (const chapter of chapters) {
        chapter.hidden = !chapter.querySelector('[data-grammar-entry]:not([hidden])')
      }

      if (results) results.textContent = visibleCount + ' 条'
      if (empty) empty.hidden = visibleCount !== 0
    }

    input.addEventListener('input', applyFilters)
    for (const filter of filters) {
      filter.addEventListener('click', () => {
        activeFilter = filter.getAttribute('data-grammar-filter') || 'all'
        for (const item of filters) item.setAttribute('aria-pressed', String(item === filter))
        applyFilters()
      })
    }

    applyFilters()
  }

  function activateTab(name, persist = true) {
    const tab = document.querySelector('[data-tab="' + name + '"]')
    const panel = document.querySelector('[data-panel="' + name + '"]')
    if (!tab || !panel) return

    document.querySelectorAll('[data-tab]').forEach((item) => {
      item.setAttribute('aria-selected', String(item === tab))
      item.setAttribute('tabindex', item === tab ? '0' : '-1')
    })
    document.querySelectorAll('[data-panel]').forEach((item) => {
      item.hidden = item !== panel
    })
    if (persist) storage.set('ieltsy:annotation-tab', name)
  }

  initializeLessonState()
  initializeGrammarLibrary()
  activateTab(storage.get('ieltsy:annotation-tab') || 'words', false)

  document.addEventListener('click', (event) => {
    const target = event.target
    if (!(target instanceof Element)) return

    const tab = target.closest('[data-tab]')
    if (tab) {
      activateTab(tab.getAttribute('data-tab') || 'words')
      return
    }

    const reference = target.closest('.sentence-ref')
    if (reference) {
      const number = reference.getAttribute('data-target')
      const sentence = number ? document.getElementById('sentence-' + number) : null
      if (sentence) {
        sentence.classList.add('is-flashed')
        window.setTimeout(() => sentence.classList.remove('is-flashed'), 900)
      }
      return
    }

    const speakable = target.closest('[data-speak]')
    if (speakable) {
      if (document.body.classList.contains('dictation-mode')) return
      if (document.body.classList.contains('practice') && speakable.classList.contains('target')) {
        speakable.classList.add('revealed')
      }
      speak({
        text: speakable.getAttribute('data-speak') || speakable.textContent || '',
        audio: speakable.getAttribute('data-audio'),
        sentence: speakable.closest('.sentence'),
        number: speakable.closest('.sentence')?.getAttribute('data-number'),
      })
      event.stopPropagation()
      return
    }

    const control = target.closest('[data-action]')
    const action = control?.getAttribute('data-action')

    if (action === 'play-all') {
      if (control?.getAttribute('aria-pressed') === 'true') {
        cancelPlayback()
        announce('已停止全文朗读')
        return
      }

      const items = Array.from(document.querySelectorAll('.sentence')).map((sentence) => ({
        text: sentence.getAttribute('data-text') || '',
        audio: sentence.getAttribute('data-audio'),
        requireAudio: true,
        number: sentence.getAttribute('data-number'),
        sentence,
      })).filter((item) => item.text)
      playSequence(items)
      return
    }

    if (action === 'play-sentence') {
      if (document.body.classList.contains('dictation-mode')) return
      const sentence = control?.closest('.sentence')
      speak({
        text: sentence?.getAttribute('data-text') || '',
        audio: sentence?.getAttribute('data-audio'),
        requireAudio: true,
        number: sentence?.getAttribute('data-number'),
        sentence,
      })
      return
    }

    if (action === 'toggle-zh') {
      document.body.classList.toggle('hide-zh')
      const visible = !document.body.classList.contains('hide-zh')
      storage.set('ieltsy:show-zh', visible ? '1' : '0')
      syncViewControls()
      announce(visible ? '译文已显示' : '译文已隐藏')
      return
    }

    if (action === 'toggle-follow') {
      document.body.classList.toggle('hide-follow')
      const visible = !document.body.classList.contains('hide-follow')
      storage.set('ieltsy:show-follow', visible ? '1' : '0')
      syncViewControls()
      announce(visible ? '跟读标记已显示' : '跟读标记已隐藏')
      return
    }

    if (action === 'toggle-practice') {
      document.body.classList.toggle('practice')
      document.querySelectorAll('.target.revealed').forEach((item) => item.classList.remove('revealed'))
      const active = document.body.classList.contains('practice')
      storage.set('ieltsy:practice', active ? '1' : '0')
      syncViewControls()
      announce(active ? '遮词练习已开启' : '遮词练习已关闭')
      return
    }

    if (action === 'toggle-sentence-answer') {
      if (!document.body.classList.contains('dictation-mode')) return
      const sentence = control?.closest('.sentence')
      if (!(sentence instanceof HTMLElement)) return
      const visible = sentence.classList.toggle('dictation-answer-visible')
      syncSentenceAnswerControl(sentence)
      announce('第 ' + (sentence.getAttribute('data-number') || '') + ' 句英文已' + (visible ? '显示' : '隐藏'))
      return
    }

    if (action === 'toggle-dictation') {
      document.body.classList.toggle('dictation-mode')
      const active = document.body.classList.contains('dictation-mode')
      if (active) cancelPlayback()
      resetSentenceAnswers()
      storage.set('ieltsy:dictation', active ? '1' : '0')
      syncViewControls()
      announce(active ? '逐句中译英默写模式已开启' : '中译英默写模式已关闭')
      return
    }

    const sentence = target.closest('.sentence')
    if (sentence && !document.body.classList.contains('dictation-mode') && !target.closest('a, button, input')) {
      speak({
        text: sentence.getAttribute('data-text') || '',
        audio: sentence.getAttribute('data-audio'),
        requireAudio: true,
        number: sentence.getAttribute('data-number'),
        sentence,
      })
    }
  })

  document.addEventListener('keydown', (event) => {
    const currentTab = event.target instanceof Element ? event.target.closest('[data-tab]') : null
    if (!currentTab || (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight')) return

    const tabs = Array.from(document.querySelectorAll('[data-tab]'))
    const index = tabs.indexOf(currentTab)
    const offset = event.key === 'ArrowRight' ? 1 : -1
    const next = tabs[(index + offset + tabs.length) % tabs.length]
    if (!(next instanceof HTMLElement)) return
    event.preventDefault()
    activateTab(next.dataset.tab || 'words')
    next.focus()
  })
})()
