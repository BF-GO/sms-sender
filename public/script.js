document.addEventListener('DOMContentLoaded', () => {
	const form = document.getElementById('smsForm');
	const resultDiv = document.getElementById('result');
	const statsContent = document.getElementById('statsContent');
	const balanceInfoDiv = document.getElementById('balanceInfo');
	const checkBalanceBtn = document.getElementById('checkBalanceBtn');

	async function fetchBalanceInfo() {
		balanceInfoDiv.textContent = 'Отправка запроса на баланс...';

		try {
			const smsResponse = await fetch('/check-balance', {
				method: 'POST',
			});

			if (!smsResponse.ok) {
				throw new Error('Не удалось отправить запрос на проверку баланса');
			}

			await new Promise((resolve) => setTimeout(resolve, 1000));

			const response = await fetch('/balance-info');
			if (!response.ok) {
				throw new Error('Не удалось получить информацию о балансе');
			}

			const data = await response.json();
			if (data.success) {
				balanceInfoDiv.innerHTML = `
					<p>Текущий баланс: ${data.currentBalance}</p>
					<p>Предыдущий баланс: ${data.previousBalance || 'N/A'}</p>
					<p>Потрачено с последней проверки: ${data.spent || '0.00 €'}</p>
				`;
			} else {
				balanceInfoDiv.textContent = data.error;
			}
		} catch (error) {
			balanceInfoDiv.textContent =
				'Ошибка при проверке баланса: ' + error.message;
		}
	}

	form.addEventListener('submit', async (event) => {
		event.preventDefault();

		const phoneNumbers = document.getElementById('phoneNumbers').value;
		const message = document.getElementById('message').value;

		try {
			const response = await fetch('/send-sms', {
				method: 'POST',
				headers: {
					'Content-Type': 'application/json',
				},
				body: JSON.stringify({ phoneNumbers, message }),
			});

			const data = await response.json();

			if (response.ok) {
				resultDiv.textContent = 'SMS успешно отправлено!';
				setTimeout(fetchBalanceInfo, 500);
			} else {
				resultDiv.textContent =
					'Ошибка: ' + (data.error || 'Не удалось отправить SMS.');
			}
		} catch (error) {
			resultDiv.textContent = 'Ошибка: ' + error.message;
		}
	});

	checkBalanceBtn.addEventListener('click', fetchBalanceInfo);

	async function fetchStats() {
		try {
			const response = await fetch('/stats');
			if (!response.ok) throw new Error('Не удалось получить статистику');
			const stats = await response.json();
			statsContent.textContent = JSON.stringify(stats, null, 2);
		} catch (error) {
			statsContent.textContent =
				'Ошибка получения статистики: ' + error.message;
		}
	}

	fetchStats();
	setInterval(fetchStats, 60000);
});
