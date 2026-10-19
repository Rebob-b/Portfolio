const contactForm = document.querySelector("[data-contact-form]");
const formStatus = document.querySelector("[data-form-status]");

if (contactForm && formStatus) {
    const statusFromUrl = new URLSearchParams(window.location.search).get("status");
    if (statusFromUrl === "sent") {
        formStatus.textContent = "Bedankt voor je bericht. Het is verstuurd.";
        formStatus.dataset.state = "success";
    } else if (statusFromUrl === "error") {
        formStatus.textContent = "Het bericht kon niet worden verstuurd. Probeer het later opnieuw.";
        formStatus.dataset.state = "error";
    }

    contactForm.addEventListener("submit", async (event) => {
        event.preventDefault();
        const submitButton = contactForm.querySelector("[type=submit]");
        submitButton.disabled = true;
        contactForm.setAttribute("aria-busy", "true");
        formStatus.textContent = "Bericht wordt verstuurd...";
        formStatus.dataset.state = "";

        try {
            const response = await fetch(contactForm.action, {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify(Object.fromEntries(new FormData(contactForm)))
            });
            const result = await response.json();

            if (!response.ok) {
                throw new Error(result.error || "Versturen is niet gelukt.");
            }

            formStatus.textContent = result.message;
            formStatus.dataset.state = "success";
            contactForm.reset();
        } catch (error) {
            formStatus.textContent = error.message || "Er ging iets mis. Probeer het later opnieuw.";
            formStatus.dataset.state = "error";
        } finally {
            submitButton.disabled = false;
            contactForm.removeAttribute("aria-busy");
        }
    });
}