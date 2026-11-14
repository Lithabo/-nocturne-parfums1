const slug = new URLSearchParams(location.search).get('store') || 'nocturne';
document.querySelector('#return').search = '?store='+encodeURIComponent(slug);
const form = document.querySelector('form');
form.addEventListener('submit',async event => {
  event.preventDefault();
  const button = form.querySelector('button');
  const status = form.querySelector('[role=status]');
  button.disabled = true;
  try {
    const response = await fetch('/api/store/'+encodeURIComponent(slug)+'/contact',{
      method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(Object.fromEntries(new FormData(form)))
    });
    const result = await response.json();
    if (!response.ok) throw new Error(result.error);
    form.reset();
    status.textContent = 'Thank you. Your enquiry has been received.';
  } catch (error) {
    status.textContent = error.message || 'Please try again.';
  } finally {
    button.disabled = false;
  }
});
