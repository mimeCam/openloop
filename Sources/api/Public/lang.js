// lang.js — shared language switcher. Active state persists in localStorage.
// Pages pass an onChange hook to re-render their own lang-dependent content.
function initLangSwitcher(onChange) {
    bindLangButtons(localStorage.getItem('openloop-lang') || 'en', onChange);
}

function bindLangButtons(current, onChange) {
    document.querySelectorAll('.lang-btn').forEach(btn => {
        btn.addEventListener('click', () => setLang(btn.dataset.lang, onChange));
        syncLangButton(btn, current);
    });
}

function setLang(lang, onChange) {
    localStorage.setItem('openloop-lang', lang);
    document.querySelectorAll('.lang-btn').forEach(btn => syncLangButton(btn, lang));
    if (onChange) onChange(lang);
}

function syncLangButton(btn, lang) {
    const active = btn.dataset.lang === lang;
    btn.classList.toggle('active', active);
    btn.setAttribute('aria-pressed', active);
}
