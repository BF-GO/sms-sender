require('dotenv').config();
const express = require('express');
const path = require('path');
const huaweiLteApi = require('huawei-lte-api');
const fs = require('fs');

const { promises: fsPromises } = require('fs');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.static(path.join(__dirname, 'public')));
app.use(express.json());

let connectionInstance = null;
let userInstance = null;

const BoxTypeEnum = {
	LOCAL_INBOX: 1,
	LOCAL_OUTBOX: 2,
	SIM_INBOX: 3,
	SIM_OUTBOX: 4,
};

let previousBalance = null;
let lastProcessedIndex = null;
async function loadPreviousBalance() {
	try {
		const data = await fsPromises.readFile('previous_balance.json', 'utf-8');
		const parsed = JSON.parse(data);
		if (typeof parsed.previousBalance === 'number') {
			previousBalance = parsed.previousBalance;
			console.log(`Загруженный предыдущий баланс: ${previousBalance} €`);
		}
	} catch (error) {
		if (error.code !== 'ENOENT') {
			console.error('Ошибка загрузки предыдущего баланса:', error);
		} else {
			console.log('Файл с предыдущим балансом не найден. Начинаем с null.');
		}
	}
}

async function savePreviousBalance() {
	try {
		await fsPromises.writeFile(
			'previous_balance.json',
			JSON.stringify({ previousBalance }, null, 2)
		);
		console.log(`Баланс ${previousBalance} € сохранён в файл.`);
	} catch (error) {
		console.error('Ошибка сохранения баланса:', error);
	}
}

loadPreviousBalance();

async function createConnection() {
	if (connectionInstance) {
		return connectionInstance;
	}

	try {
		const connection = new huaweiLteApi.Connection(process.env.ROUTER_URL);

		try {
			await connection.ready;
		} catch (e) {
			if (e.code === 108003) {
				console.warn('Уже выполнен вход. Продолжаем с текущей сессией.');
			} else {
				throw e;
			}
		}

		connectionInstance = connection;

		if (!userInstance) {
			userInstance = new huaweiLteApi.User(
				connection,
				process.env.ROUTER_USERNAME || 'admin',
				process.env.ROUTER_PASSWORD
			);
			try {
				await userInstance.login();
				console.log('Авторизация успешна.');
			} catch (e) {
				if (e.code === 108003) {
					console.warn('Уже выполнен вход при попытке логина.');
				} else {
					throw e;
				}
			}
		}

		return connection;
	} catch (error) {
		console.error('Ошибка создания подключения:', error);
		throw error;
	}
}

function delay(ms) {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

async function sendSms(phoneNumbersArray, message) {
	const connection = await createConnection();
	const sms = new huaweiLteApi.Sms(connection);
	return sms.sendSms(phoneNumbersArray, message);
}

async function fetchStats() {
	const connection = await createConnection();
	const monitoring = new huaweiLteApi.Monitoring(connection);
	const device = new huaweiLteApi.Device(connection);

	const trafficStats = await monitoring.trafficStatistics();
	const signalInfo = await device.signal();
	const deviceInfo = await device.information();

	return { trafficStats, signalInfo, deviceInfo };
}

async function readIncomingSms() {
	const connection = await createConnection();
	const sms = new huaweiLteApi.Sms(connection);

	const response = await sms.getSmsList(1, BoxTypeEnum.LOCAL_INBOX, 50);
	console.log('SMS List Response:', response);

	if (response && response.Messages) {
		let messages = response.Messages.Message;

		if (!messages) {
			return [];
		}

		if (!Array.isArray(messages)) {
			messages = [messages];
		}

		messages.sort((a, b) => new Date(b.Date) - new Date(a.Date));

		return messages.filter((msg) => msg.Smstat === '0');
	}

	return [];
}

function extractBalance(smsText) {
	const balanceMatch = smsText.match(/saldo on[:\s]*([\d.,]+)\s*€/i);
	if (balanceMatch) {
		return parseFloat(balanceMatch[1].replace(',', '.'));
	}
	return null;
}

async function waitForBalanceMessage(attempts = 5, delayTime = 1000) {
	for (let i = 0; i < attempts; i++) {
		const messages = await readIncomingSms();
		const newMessages = messages.filter(
			(msg) => msg.Index !== lastProcessedIndex
		);
		const balanceMsg = newMessages.find((msg) => /saldo on/i.test(msg.Content));
		if (balanceMsg) {
			lastProcessedIndex = balanceMsg.Index;
			return balanceMsg;
		}
		console.log(
			`Попытка ${i + 1}: Сообщение с балансом не найдено, повторная проверка...`
		);
		await delay(delayTime);
	}
	throw new Error('Сообщение с балансом не получено.');
}

const balanceLogFile = path.join(__dirname, 'balance_logs.json');

async function saveMessageToHistory(message) {
	const logEntry = {
		phone: message.Phone,
		content: message.Content,
		date: new Date(message.Date).toISOString(),
	};

	try {
		let existingLogs = [];
		try {
			const fileData = await fsPromises.readFile(balanceLogFile, 'utf-8');
			existingLogs = JSON.parse(fileData);
		} catch (err) {
			if (err.code !== 'ENOENT') {
				throw err;
			}
		}

		existingLogs.push(logEntry);
		existingLogs.sort((a, b) => new Date(a.date) - new Date(b.date));

		await fsPromises.writeFile(
			balanceLogFile,
			JSON.stringify(existingLogs, null, 2)
		);
		console.log('Сообщение успешно сохранено в историю.');
	} catch (error) {
		console.error('Ошибка записи сообщения в историю:', error);
	}
}

app.post('/send-sms', async (req, res) => {
	try {
		const { phoneNumbers, message } = req.body;
		if (!phoneNumbers || !message) {
			return res
				.status(400)
				.json({ error: 'Номера телефонов и сообщение обязательны.' });
		}

		const phoneNumbersArray = phoneNumbers.split(',').map((num) => num.trim());
		const result = await sendSms(phoneNumbersArray, message);

		if (previousBalance === null) {
			console.log('Получение начального баланса...');
			const balanceMsg = await waitForBalanceMessage();
			previousBalance = extractBalance(balanceMsg.Content);
			console.log(`Начальный баланс: ${previousBalance} €`);
			await savePreviousBalance();
		} else {
			console.log(`Текущий сохранённый баланс: ${previousBalance} €`);
		}

		await sendSms(['18258'], 'TILI');

		res.json({
			success: true,
			result,
			previousBalance:
				previousBalance !== null ? `${previousBalance} €` : 'N/A',
		});
	} catch (error) {
		console.error('Ошибка в /send-sms:', error);
		res.status(500).json({ error: 'Не удалось отправить SMS.' });
	}
});

app.post('/check-balance', async (req, res) => {
	try {
		const smsNumber = '18258';
		const smsText = 'TILI';
		const result = await sendSms([smsNumber], smsText);
		res.json({ success: true, result });
	} catch (error) {
		console.error('Ошибка при проверке баланса через SMS:', error);
		res
			.status(500)
			.json({ error: 'Не удалось отправить запрос на проверку баланса.' });
	}
});

app.get('/balance', async (req, res) => {
	try {
		const messages = await readIncomingSms();
		console.log('Retrieved SMS messages:', messages);
		const balanceMsg = messages.find(
			(msg) => msg.Content && /saldo on/i.test(msg.Content)
		);
		if (balanceMsg) {
			const balance = extractBalance(balanceMsg.Content);
			if (balance !== null) {
				await new huaweiLteApi.Sms(await createConnection()).deleteSms(
					balanceMsg.Index
				);
				return res.json({ success: true, balance: `${balance} €` });
			}
		}
		res.json({
			success: false,
			error: 'Баланс не найден в полученных сообщениях.',
		});
	} catch (error) {
		console.error('Ошибка при чтении SMS:', error);
		res.status(500).json({ error: 'Не удалось прочитать SMS.' });
	}
});

app.get('/balance-info', async (req, res) => {
	try {
		console.log('Проверяем сообщения на наличие баланса...');

		const balanceMsg = await waitForBalanceMessage(5, 3000);

		if (balanceMsg && /saldo on/i.test(balanceMsg.Content)) {
			const currentBalance = extractBalance(balanceMsg.Content);
			const oldBalance = previousBalance;
			let spent = null;

			if (oldBalance !== null && currentBalance < oldBalance) {
				spent = oldBalance - currentBalance;
			} else if (oldBalance !== null && currentBalance > oldBalance) {
				console.log('Баланс увеличился или остался прежним.');
			}

			console.log(`Предыдущий баланс: ${oldBalance} €`);
			console.log(`Текущий баланс: ${currentBalance} €`);
			console.log(
				`Потрачено с последней проверки: ${
					spent !== null ? spent.toFixed(2) : '0.00'
				} €`
			);

			previousBalance = currentBalance;
			await savePreviousBalance();

			await saveMessageToHistory(balanceMsg);

			const sms = new huaweiLteApi.Sms(await createConnection());
			await sms.deleteSms(balanceMsg.Index);
			console.log(`Удалено сообщение с индексом: ${balanceMsg.Index}`);

			return res.json({
				success: true,
				currentBalance: `${currentBalance.toFixed(2)} €`,
				previousBalance:
					oldBalance !== null ? `${oldBalance.toFixed(2)} €` : 'N/A',
				spent: spent !== null ? `${spent.toFixed(2)} €` : '0.00 €',
			});
		}

		res.json({ success: false, error: 'Баланс не найден в новых сообщениях.' });
	} catch (error) {
		console.error('Ошибка при получении информации о балансе:', error);
		res
			.status(500)
			.json({ error: 'Не удалось получить информацию о балансе.' });
	}
});

app.get('/balance-history', (req, res) => {
	try {
		if (fs.existsSync(balanceLogFile)) {
			const history = JSON.parse(fs.readFileSync(balanceLogFile, 'utf-8'));
			return res.json({ success: true, history });
		} else {
			return res.json({ success: true, history: [] });
		}
	} catch (error) {
		console.error('Ошибка при чтении истории баланса:', error);
		res.status(500).json({ error: 'Не удалось получить историю баланса.' });
	}
});

app.get('/stats', async (req, res) => {
	try {
		const stats = await fetchStats();
		res.json(stats);
	} catch (error) {
		console.error('Ошибка получения статистики:', error);
		res.status(500).json({ error: 'Не удалось получить статистику.' });
	}
});

app.listen(PORT, () => {
	console.log(`Сервер запущен на порту ${PORT}`);
});
