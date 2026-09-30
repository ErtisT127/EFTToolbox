import { useState, type ReactNode } from 'react';
import { HandCoins } from 'lucide-react';
import appIcon from '../../../assets/app-icon.png';
import { RewardDialog } from '../../../components/RewardDialog';
import { useLocale } from '../../../hooks/useLocale';
import { openExternal } from '../../../lib/hostWindow';
// The thanks list is generated from scripts/config/third-party.mjs, the same source the packaged
// THIRD-PARTY-NOTICES.txt comes from.
import { thirdParty } from '../../../third-party.gen';
import { useUpdate } from '../../../stores/updateStore';

const repositoryUrl = 'https://github.com/ErtisT127/EFTToolbox';
const authorUrl = 'https://github.com/ErtisT127';
const authorName = 'ErtisT127';

/**
 * A link the shell opens in the system browser. Handing the click over keeps the app window where it
 * is; the anchor is still a real link, so copying the address or opening it in a new tab works.
 */
function AboutLink({
  href,
  label,
  className,
  children,
}: {
  href: string;
  label: string;
  className: string;
  children: ReactNode;
}) {
  return (
    <a
      className={className}
      href={href}
      target="_blank"
      rel="noreferrer"
      title={label}
      onClick={(event) => {
        event.preventDefault();
        openExternal(href);
      }}
    >
      {children}
    </a>
  );
}

export function AboutTab() {
  const { t } = useLocale();
  const updates = useUpdate();
  const [rewardOpen, setRewardOpen] = useState(false);
  const { phase, checking, current, latest } = updates.current;
  const action = checking ? 'checking' : phase === 'idle' ? 'check' : 'recheck';
  const status =
    phase === 'available'
      ? t('settings.about.updateAvailable', { version: latest })
      : t(
          phase === 'latest'
            ? 'settings.about.updateLatest'
            : phase === 'failed'
              ? 'settings.about.updateFailed'
              : 'settings.about.updateIdle',
        );
  return (
    <>
      <div className="about-hero">
        <img className="about-mark" src={appIcon} alt="" width={64} height={64} />
        <div className="about-name">
          EFT<span> TOOLBOX</span>
        </div>
        <AboutLink
          className="about-version"
          href={repositoryUrl}
          label={t('settings.about.openRepository')}
        >
          {current || '-'}
        </AboutLink>
        <div className="about-author">
          {/* "By." and the name read as one word and sit on the centre line; the reward entry hangs
              off their right edge so it cannot shift them. */}
          <span className="about-byline">
            {t('settings.about.byline')}
            <AboutLink
              className="about-link"
              href={authorUrl}
              label={t('settings.about.openAuthor')}
            >
              {authorName}
            </AboutLink>
            <button
              className="icon-button about-reward"
              aria-label={t('settings.about.sponsor')}
              title={t('settings.about.sponsor')}
              onClick={() => setRewardOpen(true)}
            >
              <HandCoins size={20} />
            </button>
          </span>
        </div>
      </div>
      <fieldset>
        <legend>{t('settings.about.updateTitle')}</legend>
        <div className="about-row">
          <span className={`about-status about-status-${phase}`}>{status}</span>
          <button disabled={checking} onClick={() => void updates.check({ force: true })}>
            {checking && <span className="small-spinner" aria-hidden="true" />}
            {t(`settings.about.${action}`)}
          </button>
        </div>
      </fieldset>
      <fieldset>
        <legend>{t('settings.about.licensesTitle')}</legend>
        <div className="about-licenses">
          {thirdParty.map((item) => (
            // The tooltip shows where the link goes, which the row itself cannot say.
            <AboutLink key={item.name} className="about-link" href={item.url} label={item.url}>
              {t('settings.about.licenseEntry', { name: item.name, license: item.license })}
            </AboutLink>
          ))}
        </div>
      </fieldset>
      <RewardDialog open={rewardOpen} onClose={() => setRewardOpen(false)} />
    </>
  );
}
