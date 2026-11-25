const title = document.getElementById("title");
const message = document.getElementById("message");
const warning = document.getElementById("warning");
const warningTitle = document.getElementById("warning-title");
const warningMessage = document.getElementById("warning-message");
const authorize = document.getElementById("authorize");
const authorizeLabel = document.getElementById("authorize-label");
const deny = document.getElementById("deny");

let answered = false;

async function answer(approved) {
  if (answered) {
    return;
  }
  answered = true;
  authorize.disabled = true;
  deny.disabled = true;
  await window.ipc.platform.answerSshApprovalWindow(approved);
}

void window.ipc.platform.getSshApprovalWindowRequest().then((request) => {
  if (request == null) {
    void answer(false);
    return;
  }

  document.title = request.title;
  title.textContent = request.title;
  message.textContent = request.message;
  authorizeLabel.textContent = request.authorizeLabel;
  deny.textContent = request.denyLabel;

  if (request.warningTitle && request.warningMessage) {
    warningTitle.textContent = request.warningTitle;
    warningMessage.textContent = request.warningMessage;
    warning.classList.add("visible");
  }

  authorize.focus();
});

authorize.addEventListener("click", () => void answer(true));
deny.addEventListener("click", () => void answer(false));
window.addEventListener("keydown", (event) => {
  if (event.isComposing || event.repeat) {
    return;
  }
  if (event.key === "Enter") {
    event.preventDefault();
    void answer(true);
  }
  if (event.key === "Escape") {
    event.preventDefault();
    void answer(false);
  }
});
