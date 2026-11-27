// Outgoing email (nodemailer): account confirmation and password reset links.
// Without PANOMATIX_SMTP_URL the messages are printed on the console instead (development).
import nodemailer from 'nodemailer';

const TEXTS = {
  en: {
    verify: {
      subject: 'Confirm your Panomatix account',
      intro: 'Hello {name},\n\nTo finish creating your Panomatix account, choose your password by opening this link:',
    },
    reset: {
      subject: 'Reset your Panomatix password',
      intro: 'Hello {name},\n\nSomeone (hopefully you) asked to reset the password of your Panomatix account. Choose a new password by opening this link:',
    },
    exists: {
      subject: 'Your Panomatix account',
      intro: 'Hello {name},\n\nSomeone tried to create a Panomatix account with this address, but you already have one. If you forgot your password, choose a new one by opening this link:',
    },
    expiry: 'The link is valid for {hours} hour(s) and can be used once.',
    ignore: 'If you did not ask for this, ignore this message: nothing will change.',
  },
  fr: {
    verify: {
      subject: 'Confirmez votre compte Panomatix',
      intro: 'Bonjour {name},\n\nPour terminer la création de votre compte Panomatix, choisissez votre mot de passe en ouvrant ce lien :',
    },
    reset: {
      subject: 'Réinitialisez votre mot de passe Panomatix',
      intro: 'Bonjour {name},\n\nQuelqu’un (sans doute vous) a demandé à réinitialiser le mot de passe de votre compte Panomatix. Choisissez un nouveau mot de passe en ouvrant ce lien :',
    },
    exists: {
      subject: 'Votre compte Panomatix',
      intro: 'Bonjour {name},\n\nQuelqu’un a essayé de créer un compte Panomatix avec cette adresse, mais vous en avez déjà un. Si vous avez oublié votre mot de passe, choisissez-en un nouveau en ouvrant ce lien :',
    },
    expiry: 'Le lien est valable {hours} heure(s) et ne peut servir qu’une fois.',
    ignore: 'Si vous n’êtes pas à l’origine de cette demande, ignorez ce message : rien ne changera.',
  },
  de: {
    verify: {
      subject: 'Bestätigen Sie Ihr Panomatix-Konto',
      intro: 'Hallo {name},\n\num die Erstellung Ihres Panomatix-Kontos abzuschließen, wählen Sie Ihr Passwort über diesen Link:',
    },
    reset: {
      subject: 'Panomatix-Passwort zurücksetzen',
      intro: 'Hallo {name},\n\njemand (hoffentlich Sie) hat das Zurücksetzen des Passworts Ihres Panomatix-Kontos angefordert. Wählen Sie ein neues Passwort über diesen Link:',
    },
    exists: {
      subject: 'Ihr Panomatix-Konto',
      intro: 'Hallo {name},\n\njemand hat versucht, mit dieser Adresse ein Panomatix-Konto zu erstellen, aber Sie haben bereits eines. Wenn Sie Ihr Passwort vergessen haben, wählen Sie über diesen Link ein neues:',
    },
    expiry: 'Der Link ist {hours} Stunde(n) gültig und kann einmal verwendet werden.',
    ignore: 'Wenn Sie das nicht angefordert haben, ignorieren Sie diese Nachricht: Es ändert sich nichts.',
  },
  es: {
    verify: {
      subject: 'Confirme su cuenta de Panomatix',
      intro: 'Hola {name}:\n\nPara terminar de crear su cuenta de Panomatix, elija su contraseña abriendo este enlace:',
    },
    reset: {
      subject: 'Restablezca su contraseña de Panomatix',
      intro: 'Hola {name}:\n\nAlguien (seguramente usted) ha pedido restablecer la contraseña de su cuenta de Panomatix. Elija una nueva contraseña abriendo este enlace:',
    },
    exists: {
      subject: 'Su cuenta de Panomatix',
      intro: 'Hola {name}:\n\nAlguien ha intentado crear una cuenta de Panomatix con esta dirección, pero usted ya tiene una. Si ha olvidado su contraseña, elija una nueva abriendo este enlace:',
    },
    expiry: 'El enlace es válido durante {hours} hora(s) y solo puede usarse una vez.',
    ignore: 'Si no lo ha pedido, ignore este mensaje: no cambiará nada.',
  },
};

const fill = (s, vars) => s.replace(/\{(\w+)\}/g, (_, k) => vars[k] ?? '');

export const MAIL_LANGUAGES = Object.keys(TEXTS);

/** A link message — `verify` (new account), `reset` (forgotten password) or `exists` (sign-up with an
 *  address that already has an account) — in one of the interface languages. */
export function linkMessage({ kind, lang, name, link, hours }) {
  const T = TEXTS[lang] ?? TEXTS.en;
  const vars = { name, hours };
  return {
    subject: T[kind].subject,
    text: `${fill(T[kind].intro, vars)}\n\n${link}\n\n${fill(T.expiry, vars)}\n${T.ignore}\n`,
  };
}

/** Returns `{ send({to, subject, text}) }`. */
export function createMailer(config) {
  if (!config.smtpUrl) {
    return {
      async send(msg) {
        console.log(`--- email (not sent: PANOMATIX_SMTP_URL is not set) ---\nTo: ${msg.to}\nSubject: ${msg.subject}\n\n${msg.text}---`);
      },
    };
  }
  const transport = nodemailer.createTransport(config.smtpUrl);
  return { send: (msg) => transport.sendMail({ from: config.mailFrom, ...msg }) };
}
