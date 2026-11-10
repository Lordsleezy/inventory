/** Open Square from the tap. A popup is blocked on the store phone. */
export function squareLaunchUrl(userAgent: string): string {
  if (/Android/i.test(userAgent)) {
    return 'intent:#Intent;action=android.intent.action.MAIN;category=android.intent.category.LAUNCHER;package=com.squareup;end';
  }
  return 'square-commerce-v1://';
}
