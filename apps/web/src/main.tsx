import { createRoot } from 'react-dom/client';
import { formatMoney, money } from '@sbm/domain';

createRoot(document.getElementById('root') as HTMLElement).render(
  <p>{formatMoney(money('BDT', '1234567.89'))}</p>,
);
