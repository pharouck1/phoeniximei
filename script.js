const form = document.querySelector('#imei-form');
const input = document.querySelector('#imei');
const errorCallout = document.querySelector('#error-callout');
const count = document.querySelector('#char-count');
const submitButton = document.querySelector('#submit-button');
const buttonLabel = submitButton.querySelector('.button-label');
const resultPanel = document.querySelector('#device-result');
let latestSerial = '';

function digitsOnly(value) { return value.replace(/\D/g, '').slice(0, 15); }

function isValidLuhn(value) {
  let sum = 0;
  for (let index = 0; index < value.length; index += 1) {
    let digit = Number(value[value.length - 1 - index]);
    if (index % 2 === 1) {
      digit *= 2;
      if (digit > 9) digit -= 9;
    }
    sum += digit;
  }
  return sum % 10 === 0;
}

function showError(message) {
  errorCallout.textContent = message;
  errorCallout.hidden = false;
}

function setLoading(loading) {
  input.disabled = loading;
  submitButton.disabled = loading;
  document.querySelector('#paste').disabled = loading;
  form.setAttribute('aria-busy', String(loading));
  buttonLabel.textContent = loading ? 'Querying database…' : 'Check device';
  submitButton.classList.toggle('loading', loading);
}

function valueOrUnavailable(value) {
  return value === null || value === undefined || value === '' ? 'Unavailable' : String(value);
}

function lockPresentation(status) {
  const normalized = String(status ?? 'Unknown').trim().toLowerCase();
  if (['off', 'disabled', 'false', 'clear', 'unlocked', 'no'].includes(normalized)) return { label: 'OFF', className: 'off' };
  if (['on', 'enabled', 'true', 'locked', 'yes'].includes(normalized)) return { label: 'ON', className: 'on' };
  return { label: 'Unknown', className: 'unknown' };
}

function renderResult(data) {
  document.querySelector('#result-model').textContent = valueOrUnavailable(data.model);
  latestSerial = data.serialNumber ? String(data.serialNumber) : '';
  document.querySelector('#result-serial').textContent = valueOrUnavailable(latestSerial);
  document.querySelector('#result-storage').textContent = valueOrUnavailable(data.storage);
  document.querySelector('#result-color').textContent = valueOrUnavailable(data.color);

  const lock = lockPresentation(data.icloudStatus);
  const lockBadge = document.querySelector('#result-lock');
  lockBadge.textContent = lock.label;
  lockBadge.className = `lock-badge ${lock.className}`;
  document.querySelector('#result-json').textContent = JSON.stringify(data, null, 2);
  resultPanel.hidden = false;
  resultPanel.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
}

input.addEventListener('input', () => {
  const imei = digitsOnly(input.value);
  input.value = imei;
  count.textContent = `${String(imei.length).padStart(2, '0')} / 15`;
  errorCallout.hidden = true;
});

document.querySelector('#paste').addEventListener('click', async () => {
  try {
    input.value = await navigator.clipboard.readText();
    input.dispatchEvent(new Event('input'));
    input.focus();
  } catch {
    showError('Clipboard access is unavailable. Paste the IMEI directly into the field.');
  }
});

form.addEventListener('submit', async (event) => {
  event.preventDefault();
  const imei = digitsOnly(input.value);
  input.value = imei;
  errorCallout.hidden = true;
  resultPanel.hidden = true;

  if (imei.length !== 15) {
    showError('Enter all 15 digits of the IMEI to continue.');
    input.focus();
    return;
  }
  if (!isValidLuhn(imei)) {
    showError('This IMEI does not pass its check digit validation. Recheck the number on the device.');
    input.focus();
    return;
  }

  setLoading(true);
  try {
    const response = await fetch('/api/check-imei', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify({ imei })
    });
    const payload = await response.json().catch(() => ({}));
    if (!response.ok || payload.success !== true) {
      throw new Error(payload.error || 'The lookup could not be completed. Please try again later.');
    }
    renderResult(payload.data);
  } catch (error) {
    showError(error instanceof TypeError
      ? 'Could not reach the lookup service. Check your connection and try again.'
      : error.message);
  } finally {
    setLoading(false);
  }
});

document.querySelector('#copy-serial').addEventListener('click', async (event) => {
  if (!latestSerial) return;
  const button = event.currentTarget;
  try {
    await navigator.clipboard.writeText(latestSerial);
    button.textContent = 'Copied';
    window.setTimeout(() => { button.textContent = 'Copy'; }, 1600);
  } catch {
    showError('Could not copy the serial number. Select and copy it manually.');
  }
});

const menu = document.querySelector('.menu-toggle');
menu.addEventListener('click', () => {
  const nav = document.querySelector('.topbar nav');
  const open = nav.classList.toggle('open');
  menu.setAttribute('aria-expanded', String(open));
  menu.setAttribute('aria-label', open ? 'Close navigation' : 'Open navigation');
});
