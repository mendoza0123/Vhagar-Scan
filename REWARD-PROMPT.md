# Vhagar POS — Reward Page Build Prompt ("Offer 4")

You are continuing to build **Vhagar POS**. The next feature is an interactive reward page to support a special promotion known as "Offer 4". This page should be engaging, mobile-first, and simple for customers to use at the booth. It must integrate smoothly with the existing application structure and philosophy.

## What to build

### Interactive Reward Page (`/reward`) — "Offer 4"

This page is a customer-facing interactive game to win a discount.

*   **Goal:** Create a "Spin the Wheel" game where customers can win a random discount. This is designed to be used on a tablet at the booth or on a customer's own phone by scanning a dedicated QR code.

*   **UI/UX:**
    *   The page should feature a large, visually appealing spinning wheel. The design should be minimalist and clean, using the project's existing Tailwind CSS configuration and color scheme.
    *   The wheel should be divided into 8 segments, each with a discount offer. The offers are:
        *   `10% OFF`
        *   `15% OFF`
        *   `20% OFF`
        *   `25% OFF`
        *   `TRY AGAIN`
        *   `30% OFF`
        *   `35% OFF`
        *   `40% OFF`
    *   A prominent "SPIN TO WIN" button should be placed below the wheel.
    *   Use the `react-custom-roulette` library for the wheel component to ensure fast development.
    *   When the "SPIN TO WIN" button is tapped:
        *   The button should be disabled to prevent multiple spins within the same session.
        *   The wheel should animate a spin for several seconds. A subtle, satisfying sound effect would be a great addition.
        *   It should land on a random segment. The randomness can be simple client-side `Math.random()`.
    *   After the wheel stops, a modal or a large text overlay should appear, clearly displaying the result.
        *   **On Win:** "Congratulations! You've won **25% OFF** your entire purchase! Show this screen to our staff to claim your discount."
        *   **On "Try Again":** "So close! Better luck next time."
        *   The result display should remain on screen until the page is reloaded.

*   **Discount Application (Integration with `/sell`):**
    *   To maintain simplicity and adhere to the "no schema changes" rule, the discount system will be manual.
    *   A staff member will view the customer's screen displaying the discount.
    *   On the `/sell` page, the staff member will manually calculate the discount amount from the cart's subtotal and enter it into the existing `discount` field before finalizing the sale.
    *   This approach requires no backend changes for one-time-use codes and fits the "rock-solid over clever" project principle.

*   **Technical Implementation:**
    *   Create a new route at `app/reward/page.tsx`.
    *   The page must be a Client Component (`'use client'`).
    *   Install the required library: `npm install react-custom-roulette`.
    *   Define the prize segments for the wheel within the component.
    *   Use React state (`useState`) to manage the spinning state, the chosen prize, and the result display.

*   **How to test:**
    *   Navigate to the `/reward` page.
    *   Click the "SPIN TO WIN" button.
    *   Verify the wheel spins and lands on a prize.
    *   Confirm the result is clearly displayed in a modal or overlay.
    *   Confirm the spin button is disabled after use. A page reload can reset it, which is acceptable for this context.