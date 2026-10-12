const root = document.documentElement;
const saved = localStorage.getItem('theme') ||
  (matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light');
root.dataset.theme = saved;

function setIcon() {
  document.querySelectorAll('#themeToggle').forEach(b => {
    b.textContent = root.dataset.theme === 'dark' ? '\u2600' : '\u263E';
  });
}
document.addEventListener('DOMContentLoaded', setIcon);
document.addEventListener('click', e => {
  if (!e.target.closest('#themeToggle')) return;
  root.dataset.theme = root.dataset.theme === 'dark' ? 'light' : 'dark';
  localStorage.setItem('theme', root.dataset.theme);
  setIcon();
});