import { be } from '../api/backend';
import { FORK } from '../fork';
import { askPrompt, askUrl } from '../lib/askLink';
import { t } from '../lib/i18n';
import { notify } from '../state/notice';
import { rackFloating, rollFloating } from '../state/pattern';
import { say, tucked, U } from '../state/ui';
import { upd } from '../state/updates';
import { APP_GLYPH } from '../ui/menuIcons';

/** View names match the English menus so ChatGPT can find them in the source. */
function currentView(): string {
  const parts = [U.mixView ? 'Mix view (F9)' : 'Playlist'];
  if (U.rackWin || rackFloating()) parts.push('Channel rack');
  if (U.rollWin || rollFloating()) parts.push('Piano roll');
  if (U.plugs.some(p => !tucked(p.z))) parts.push('an effect window');
  return parts.join(', ');
}

/** Open the browser with the question, or start a Synkopa help chat when none was entered. */
export async function askChatGPT(question = t('d.ask.starter')): Promise<boolean> {
  if (!FORK.ask) return false;
  const prompt = askPrompt(question, { version: upd().current || null, view: currentView() });
  const copy = askUrl('chatgpt', prompt) == null;
  if (copy) {
    try {
      await navigator.clipboard.writeText(prompt);
    } catch (error) {
      notify(t('d.ask.copyFailed', { error: String(error) }));
      return false;
    }
  }
  try {
    await be().openAsk('chatgpt', copy ? null : prompt);
    if (copy) notify(t('d.ask.sentPaste'));
    else say(t('d.ask.sent'));
    return true;
  } catch {
    notify(t(copy ? 'd.ask.copiedOpenFailed' : 'd.ask.openFailed'));
    return false;
  }
}

/** The labelled button beside the application menus. */
export function AskButton() {
  if (!FORK.ask) return null;
  return (
    <button class="askbtn" title={t('d.ask.tip')} onClick={() => void askChatGPT()}>
      <svg width="13" height="13" viewBox={APP_GLYPH.ask.vb} aria-hidden="true"><path d={APP_GLYPH.ask.d} fill="currentColor" /></svg>
      <span>{t('d.ask.button')}</span>
    </button>
  );
}
