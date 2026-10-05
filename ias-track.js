/* ias-track.js — page visits and payment-step clicks for the engagement score.
 *
 * Add ONE line before </body> on any page in the assessment repo:
 *   <script src="ias-track.js" defer></script>
 *
 * It sends nothing unless it knows the visitor's email (from ?email= in the link,
 * or from what they typed on the page), never blocks the page, and never shows
 * anything to the visitor. Questionnaires and yes/no answers are NOT sent from
 * here - those already reach the scorer through ias-crm.
 */
(function () {
  var URL_ = 'https://ias-score.calm-rain-5660.workers.dev/e';
  var page = (location.pathname.split('/').pop() || 'index').replace(/\.html$/, '');
  var q = new URLSearchParams(location.search);
  var campaign = q.get('utm_campaign') || '';

  function email() {
    var e = (q.get('email') || q.get('e') || '').trim();
    try { if (!e && typeof answers !== 'undefined' && answers && answers.email) e = answers.email; } catch (x) {}
    try { if (!e && typeof lastEmail !== 'undefined' && lastEmail) e = lastEmail; } catch (x) {}
    if (!e) { var f = document.querySelector('input[type=email]'); if (f && f.value) e = f.value; }
    e = String(e || '').trim();
    return (e.indexOf('@') > 0 && e.indexOf('#') === -1) ? e : '';
  }

  function send(type) {
    var e = email();
    if (!e) return;
    var body = JSON.stringify({ email: e, type: type, page: page, campaign: campaign });
    try {
      fetch(URL_, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: body, keepalive: true, mode: 'cors' })
        .catch(function () {});
    } catch (x) {}
  }
  window.iasTrack = send; // for a page that reaches payment through a button rather than a link

  // A visit, once the email is known (from the link straight away, or after the visitor types it).
  var sentView = false;
  function maybeView() { if (!sentView && email()) { sentView = true; send('view'); } }
  maybeView();
  document.addEventListener('change', maybeView, true);

  // Any click on a link that goes to payment.
  var PAY = /payment|rapyd\.|\/pay(\.html)?([?#]|$)|checkout/i;
  document.addEventListener('click', function (ev) {
    var a = ev.target && ev.target.closest ? ev.target.closest('a[href]') : null;
    if (a && PAY.test(a.href)) send('checkout');
  }, true);

  // Pages that redirect to payment with window.location instead of a link.
  if (page === 'pay') send('checkout');
})();

