import { calendarDate, calendarTimeOptions, calendarInstant, monthDays, MONTHS, WEEKDAYS } from './calendar-time.js';
import { toIso } from '../timeline/time-scale.js';
import { icon } from '../utils/dom.js';

export function openTimelineCalendar({ host, center, unit, onSelect, onClose, openRange, updateIcons }) {
  let selected = calendarDate(toIso(center).split('T')[0]), month = selected.with({ day: 1 }), focused = selected;
  let activeUnit = unit, disposed = false, request = 0;
  const panel = document.createElement('aside'); panel.className = 'timeline-calendar'; panel.setAttribute('aria-label', 'Calendar');
  panel.innerHTML = `<div class="calendar-heading"><h2>Calendar</h2><button type="button" class="calendar-close" aria-label="Close calendar" title="Close calendar">${icon('x')}</button></div>
    <div class="calendar-month"><button type="button" data-month-step="-1" aria-label="Previous month" title="Previous month">${icon('chevron-left')}</button><select aria-label="Calendar month">${MONTHS.map((name, i) => `<option value="${i + 1}">${name}</option>`).join('')}</select><input aria-label="Calendar year" type="number" min="-9999" max="9999" title="Astronomical year: 0 = 1 BC" step="1"><button type="button" data-month-step="1" aria-label="Next month" title="Next month">${icon('chevron-right')}</button></div>
    <div class="calendar-grid" role="grid" aria-label="Choose day"></div>
    <div class="calendar-time"><label><span>Center time / UTC <span class="calendar-unit"></span></span><input type="time" aria-label="Calendar center time / UTC" required></label><button type="button" class="calendar-apply" aria-label="Center on selected date and time" title="Center on selected date and time">${icon('crosshair')}</button></div>
    <output class="calendar-center" aria-label="Timeline center"></output><p class="calendar-error" role="alert" hidden></p>
    <div class="calendar-actions"><button type="button" class="calendar-today">${icon('calendar-check')}Today</button><button type="button" class="calendar-range">${icon('calendar-range')}Date and time range</button></div>`;
  host.append(panel);
  const grid = panel.querySelector('.calendar-grid'), time = panel.querySelector('input[type=time]'), year = panel.querySelector('input[type=number]'), monthSelect = panel.querySelector('select');
  const error = panel.querySelector('.calendar-error');
  const report = message => { error.textContent = message; error.hidden = !message; };
  function draw(focus = false) {
    monthSelect.value = String(month.month); year.value = String(month.year);
    panel.querySelector('[data-month-step="-1"]').disabled = month.year === -9999 && month.month === 1;
    panel.querySelector('[data-month-step="1"]').disabled = month.year === 9999 && month.month === 12;
    const days = monthDays(month);
    grid.setAttribute('aria-label', `${MONTHS[month.month - 1]} ${month.year}`);
    grid.innerHTML = `<div role="row" class="calendar-weekdays">${WEEKDAYS.map(day => `<span role="columnheader">${day}</span>`).join('')}</div>` + Array.from({ length: 6 }, (_, row) => `<div role="row">${days.slice(row * 7, row * 7 + 7).map(day => `<span role="gridcell" aria-selected="${day.date === selected.toString()}"><button type="button" data-date="${day.date}" class="${day.outside ? 'other-month' : ''}" ${day.disabled ? 'disabled' : ''} tabindex="${day.date === focused.toString() ? 0 : -1}" aria-label="${day.date}" ${day.date === new Date().toISOString().slice(0, 10) ? 'aria-current="date"' : ''}>${String(day.day).padStart(2, '0')}</button></span>`).join('')}</div>`).join('');
    if (focus) grid.querySelector(`[data-date="${focused}"]`)?.focus();
  }
  function configureTime(value) {
    const options = calendarTimeOptions(activeUnit, value);
    time.step = String(options.step); time.value = options.value; time.disabled = options.disabled;
    panel.querySelector('.calendar-unit').textContent = activeUnit[0] + activeUnit.slice(1).toLowerCase();
  }
  async function select(date) {
    const intent = ++request;
    try {
      if (!time.disabled && !time.reportValidity()) return;
      const target = calendarInstant(date, time.value, activeUnit);
      const refocus = grid.contains(document.activeElement);
      selected = focused = calendarDate(date); month = selected.with({ day: 1 }); report(''); draw(refocus);
      panel.setAttribute('aria-busy', 'true');
      await onSelect(target);
    } catch (failure) { if (!disposed && intent === request) report(failure.message); }
    finally { if (!disposed && intent === request) panel.setAttribute('aria-busy', 'false'); }
  }
  function browse(monthDelta) {
    try { month = calendarDate(month.add({ months: monthDelta })); focused = month; draw(); report(''); }
    catch { report('Choose a date in astronomical years -9999 through 9999.'); }
  }
  panel.querySelectorAll('[data-month-step]').forEach(button => { button.onclick = () => browse(Number(button.dataset.monthStep)); });
  const changeMonth = () => {
    try {
      if (!year.reportValidity()) return;
      month = calendarDate({ year: Number(year.value), month: Number(monthSelect.value), day: 1 }); focused = month; draw(); report('');
    } catch { report('Choose a valid month and year.'); }
  };
  monthSelect.onchange = changeMonth; year.onchange = changeMonth;
  grid.addEventListener('click', event => { const day = event.target.closest('[data-date]'); if (day && !day.disabled) void select(day.dataset.date); });
  grid.addEventListener('keydown', event => {
    const node = event.target.closest('[data-date]'); if (!node) return;
    const day = calendarDate(node.dataset.date); let next;
    try {
      if (['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown'].includes(event.key)) next = day.add({ days: { ArrowLeft: -1, ArrowRight: 1, ArrowUp: -7, ArrowDown: 7 }[event.key] });
      else if (event.key === 'Home') next = day.subtract({ days: day.dayOfWeek - 1 });
      else if (event.key === 'End') next = day.add({ days: 7 - day.dayOfWeek });
      else if (event.key === 'PageUp' || event.key === 'PageDown') next = day.add(event.shiftKey ? { years: event.key === 'PageUp' ? -1 : 1 } : { months: event.key === 'PageUp' ? -1 : 1 });
      if (next) { event.preventDefault(); focused = calendarDate(next); month = focused.with({ day: 1 }); draw(true); }
    } catch { event.preventDefault(); }
  });
  panel.addEventListener('keydown', event => { if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); onClose(); } });
  panel.querySelector('.calendar-close').onclick = onClose;
  panel.querySelector('.calendar-range').onclick = openRange;
  panel.querySelector('.calendar-today').onclick = () => { void select(new Date().toISOString().slice(0, 10)); };
  panel.querySelector('.calendar-apply').onclick = () => { void select(selected.toString()); };
  time.onchange = () => { void select(selected.toString()); };
  configureTime(center); draw(); updateIcons();
  grid.querySelector('[tabindex="0"]')?.focus();
  return {
    update(value, nextUnit) {
      if (disposed) return;
      panel.querySelector('.calendar-center').textContent = `${toIso(value).replace('T', ' ').replace('Z', '')} UTC`;
      const nextDay = calendarDate(toIso(value).split('T')[0]);
      if (!nextDay.equals(selected)) {
        const browsing = !month.equals(selected.with({ day: 1 }));
        selected = focused = nextDay;
        if (!browsing) month = nextDay.with({ day: 1 });
        draw();
      }
      if (nextUnit !== activeUnit) { activeUnit = nextUnit; configureTime(value); }
    },
    close() { disposed = true; ++request; panel.remove(); },
  };
}
