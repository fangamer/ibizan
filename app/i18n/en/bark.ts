import Localization from '../localization';
import { random } from '../../shared/common';

function fetch(phase: 0 | 1 | 2 | 3, username: string, thing?: string): string {
    const suffixes = [
        '',
        ' while excitedly panting',
        ' and awaits a cookie',
        ' and sits obediently',
        ' and barks loudly',
        ' and stares expectantly',
        ', then runs a quick lap around the channel'
    ];
    if (phase === 0) {
        return `_perks up and fidgets impatiently, waiting for @${username} to \`fetch [thing]\`_`;
    } else if (phase === 1) {
        return `_runs to fetch ${thing}!_`;
    } else if (phase === 2) {
        return `_returns to @${username}, unable to find ${thing}${random(suffixes)}_`;
    } else if (phase === 3) {
        return `_drops ${thing} at @${username}'s feet${random(suffixes)}_`
    }
    return '';
};

const barkCopy: Localization.BarkLocalizedCopy = {
    bark: [
        'bark',
        'bark bark',
        'bark bark bark'
    ],
    bigdog: [
        'HEH, you\'re barking up the wrong tree pup!',
        'Ya got the wrong dog, and he don\'t like being disturbed!',
        'Think you\'re ready to run with the REAL Big Dogs? Think again!',
        'Remember when I asked for your hours today? Yeah, me neither!',
        'If you can\'t punch in with the Big Dogs, stay out of #timeclock!',
        'If people could read my mind... I\'d get punched! And I ain\'t talking about your punches!',
        'Do I look like a freakin\' punch clock?',
        'Vacation? I need a six month vacation, twice a year!',
        'Let _me_ drop everything and enter _your_ punch.',
        'Think I care about your command? Talk to the paw!'
    ],
    fetch: fetch,
    goodboy: ':ok_hand:',
    story: [
        'woof woof woof',
        'bark woof bark bark woof woof',
        'whine'
    ]
};

export = barkCopy;