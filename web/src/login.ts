import "./login.css";

/** The error line for a token that the server refused. */
const WRONG_TOKEN = "wrong token";
/** The error line for a request that never reached the server. */
const NO_ANSWER = "no answer from the server. Try again.";

/**
 * The fields of the login form.
 *
 * The username field carries no secret. It is present because a password
 * manager saves more reliably from a form that holds a username and a
 * password. It stays out of the tab order and out of the accessibility tree.
 */
const FIELDS = `
<span class="login-user">
  <input
    type="text"
    name="username"
    autocomplete="username"
    value="pirate"
    readonly
    tabindex="-1"
    aria-hidden="true"
  />
</span>
<input
  id="login-token"
  type="password"
  name="password"
  autocomplete="current-password"
  aria-label="token"
  spellcheck="false"
  autocapitalize="off"
  autocorrect="off"
  autofocus
  required
/>
<button type="submit">enter</button>
<p class="login-error" role="alert"></p>
`;

/**
 * Ask the server whether the browser already holds a live session.
 *
 * A status that is neither 204 nor 401 means that the server does not answer
 * this endpoint, and a server without the endpoint runs no authentication.
 * `web/tests/stub-server.ts` is such a server, and pirate cannot change it.
 * The gate that counts is on `/ws` and is server side, so a wrong answer here
 * costs one failed WebSocket and nothing else.
 */
async function hasSession(): Promise<boolean> {
  try {
    const response = await fetch("/auth", {
      credentials: "same-origin",
      cache: "no-store",
    });
    return response.status !== 401;
  } catch {
    return true;
  }
}

/**
 * Send one token to the server.
 *
 * Returns null when the server accepted the token. Returns the line to show
 * to the operator when it did not.
 */
async function postToken(token: string): Promise<string | null> {
  let response: Response;
  try {
    response = await fetch("/auth", {
      method: "POST",
      // The server reads the raw token from the body, so the request carries
      // no JSON wrapper and no form encoding.
      headers: { "content-type": "text/plain" },
      body: token,
      credentials: "same-origin",
    });
  } catch {
    return NO_ANSWER;
  }
  switch (response.status) {
    case 204:
      return null;
    case 401:
      return WRONG_TOKEN;
    default:
      return `server error ${response.status}`;
  }
}

/**
 * The promise of the form that is on the screen, or null when no form is.
 *
 * A non-null value means that the document holds the form with the id
 * `login`. `showLogin` sets this variable, and only the removal of that form
 * clears it.
 */
let shown: Promise<void> | null = null;

/**
 * Show the login form and resolve when the server accepts a token.
 *
 * The markup is a real form with a real submit button. A password manager
 * recognizes this shape and offers to fill it and to save it.
 *
 * A second call while the form is on the screen gives back the promise of the
 * first call. Without this guard, two callers build two forms with one id and
 * two submit handlers, and each token then goes to the server twice.
 */
function showLogin(): Promise<void> {
  if (shown !== null) {
    return shown;
  }
  shown = new Promise<void>((resolve) => {
    // The attribute hides the terminal and the status line from `login.css`.
    // `style.css` belongs to another part of the client and stays unchanged.
    document.body.dataset.auth = "required";

    const form = document.createElement("form");
    form.id = "login";
    form.setAttribute("method", "post");
    form.setAttribute("action", "/auth");
    form.innerHTML = FIELDS;
    document.body.append(form);

    const token = form.querySelector<HTMLInputElement>("#login-token")!;
    const button = form.querySelector("button")!;
    const error = form.querySelector<HTMLElement>(".login-error")!;

    // The autofocus attribute has no effect on a node that a script appends,
    // so the focus is set here.
    token.focus();

    function fail(message: string): void {
      error.textContent = message;
      button.disabled = false;
      token.focus();
      // The value stays, and the selection lets one keystroke replace it.
      token.select();
    }

    function finish(): void {
      // The browser offers to save the token when the form leaves the DOM
      // after a successful submit. Remove the form for that offer, and clear
      // the value first, so that no node holds the raw token.
      token.value = "";
      form.remove();
      delete document.body.dataset.auth;
      // The guard opens again with the removal, so a later session loss shows
      // a new form.
      shown = null;
      resolve();
    }

    form.addEventListener("submit", (event: SubmitEvent): void => {
      event.preventDefault();
      if (button.disabled) {
        return;
      }
      // The disabled button holds a double click to one request.
      button.disabled = true;
      error.textContent = "";
      void postToken(token.value).then((message: string | null) => {
        if (message === null) {
          finish();
          return;
        }
        fail(message);
      });
    });
  });
  return shown;
}

/**
 * Hold the page until the browser holds a live session.
 *
 * The function returns at once when the server reports a live session, and
 * also when the server does not answer `/auth`. In every other case it shows
 * the login form and returns after the server accepts a token.
 *
 * The client never stores the raw token. The only stored credential is the
 * `HttpOnly` cookie of the browser, which no script can read.
 *
 * The function never rejects. A caller awaits it before it starts the
 * terminal.
 */
export async function requireSession(): Promise<void> {
  if (await hasSession()) {
    return;
  }
  await showLogin();
}

/**
 * Show the login form again when the session ended.
 *
 * A session can expire while the page is open. The WebSocket then closes, and
 * the browser gives no status for a failed WebSocket handshake to a script.
 * The client therefore asks `/auth` again to learn the cause of the close.
 *
 * Returns true after the server accepted a token, which means that the caller
 * must connect again. Returns false at once when the session is still live,
 * because the close then has another cause.
 *
 * The function never rejects.
 */
export async function sessionLost(): Promise<boolean> {
  if (await hasSession()) {
    return false;
  }
  await showLogin();
  return true;
}
