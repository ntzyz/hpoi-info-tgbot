import * as sqlite from 'sqlite3';
import * as http from 'http';
import * as https from 'https';
import Axios, { AxiosInstance } from 'axios';
import { JSDOM } from 'jsdom';
import * as httpsProxyAgent from 'https-proxy-agent';
import * as XRegExp from 'xregexp';
import { publish_channel_id, publish_sub_channel_id, bot_owner_id, bot_token, user_agent, cookie_utoken } from './config';

interface HpoiInformationItem {
  hobby_id: number,
  link_path: string,
  type_name: string,
  image_url: string,
  info_title: string,
  info_type: string,
};

const is_prod = process.env.NODE_ENV === 'production';
const is_test = process.env.NODE_ENV === 'test';

const telegram_invalid_image_response = 'Bad Request: wrong file identifier/HTTP URL specified';

const axios = Axios.create({
  httpsAgent: new https.Agent({ keepAlive: true, keepAliveMsecs: 10000 }),
  httpAgent: new http.Agent({ keepAlive: true, keepAliveMsecs: 10000 }),
  timeout: 30000,
});

function get_timestamp (offsetDays: number = 0): number {
  const currentTime = new Date().getTime();
  return Math.floor(currentTime / 1000 + offsetDays * 24 * 60 * 60);
}

function initialize_database (): Promise<sqlite.Database> {
  return new Promise((resolve, reject) => {
    const db = new sqlite.Database('db.sqlite');

    db.run(`CREATE TABLE IF NOT EXISTS published_records (
      hobby_id INT,
      info_type VARCHAR(128),
      publish_date VARCHAR(32),
      publish_timestamp INT
    )`, error => {
      if (error) {
        reject(error);
        return;
      }

      resolve(db);
    });
  });
}

function check_record_existence (db: sqlite.Database, hobby_id: number, info_type: string): Promise<boolean> {
  return new Promise((resolve, reject) => {
    db.get('SELECT COUNT(*) AS count FROM published_records WHERE hobby_id = ? AND info_type = ? AND publish_timestamp > ?', [
      hobby_id, info_type, get_timestamp(-7),
    ], (error, row) => {
      if (error) {
        reject(error);
        return;
      }

      resolve(row.count !== 0);
    })  
  })
}

function create_publish_record (db: sqlite.Database, hobby_id: number, info_type: string): Promise<void> {
  return new Promise((resolve, reject) => {
    db.run('INSERT INTO published_records(hobby_id, info_type, publish_date, publish_timestamp) VALUES(?, ?, date("now"), ?)', [
      hobby_id, info_type, get_timestamp(),
    ], (error) => {
      if (error) {
        reject(error);
        return;
      }

      resolve();
    })  
  })
}

async function fetch_data (): Promise<Array<HpoiInformationItem>> {
  console.info('Fetching latest feeds from www.hpoi.net');
  const request_body = 'page=1&type=info&catType=all'

  const response = await axios.post('https://www.hpoi.net/user/home/ajax', request_body, {
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      'User-Agent': user_agent,
      'Cookie': `utoken=${cookie_utoken}`
    }
  });

  const html = response.data;
  const { window } = new JSDOM(html);
  const info_list = Array.from(window.document.querySelectorAll('.home-info'));

  return info_list.map((element) => {
    const link_path = element.querySelector('.overlay-container a').getAttribute('href');
    const type_name = element.querySelector('.overlay-container .type-name').textContent.trim();
    const info_title = element.querySelector('.home-info-content .user-content').textContent.trim();
    const info_type = element.querySelector('.home-info-content .user-name').firstChild.textContent.trim();
    const hobby_id = Number(link_path.match(/\d+/ui));

    let image_url = element.querySelector('.overlay-container img').getAttribute('src');

    if (image_url.indexOf('?') > 0) {
      image_url = image_url.split('?')[0];
    }

    return {
      hobby_id,
      link_path: `https://www.hpoi.net/${link_path}`,
      type_name,
      image_url,
      info_title,
      info_type,
    } as HpoiInformationItem;
  }).reverse();
}

function escape_telegram_hashtag (text: string) {
  // special judge for ratio
  if (/^\d+\/\d+$/.test(text)) {
    return text.replace('/', '比');
  }

  return text.replace(XRegExp(`[^\\pL0-9]`, 'ig'), '_');
}

async function fetch_tags (hobby_id: number): Promise<Array<string>> {
  const response = await axios.get(`https://www.hpoi.net/hobby/${hobby_id}`, {
    headers: {
      'User-Agent': user_agent,
      'Cookie': `utoken=${cookie_utoken}`
    },
  });

  const { window } = new JSDOM(response.data);
  const { document } = window;

  const results = Array.from(document.querySelector('table.info-box')
                                     .querySelectorAll('a'))
                       .map(el => el.textContent.trim()
                                                .replace(/\s/g, '_'))
                       .map(el => escape_telegram_hashtag(el))
                       .filter(item => Boolean(item) && item !== '未知')
                       .map(el => `#${el}`);

  return results;
}

async function publish_info_to_telegram (item: HpoiInformationItem, channel_id: number, tags: string[], http: AxiosInstance) {
  try {
    await http.post(`https://api.telegram.org/bot${bot_token}/sendPhoto`, {
      chat_id: channel_id,
      parse_mode: 'HTML',
      caption: `<a href="${item.link_path}">【${item.info_type}】${item.info_title}</a>\nTags: ${tags.join(' ')}`,
      photo: item.image_url,
      disable_web_page_preview: true,
      disable_notification: true,
    });

    return 0;
  } catch (error) {
    if (error.response && error.response.status === 400 && error.response.data.description === telegram_invalid_image_response) {
      await http.post(`https://api.telegram.org/bot${bot_token}/sendMessage`, {
        chat_id: channel_id,
        parse_mode: 'HTML',
        text: `<a href="${item.link_path}">【${item.info_type}】${item.info_title}</a>\nTags: ${tags.join(' ')}`,
        disable_web_page_preview: true,
        disable_notification: true,
      });

      return 0;
    } else {
      console.info('Skipping info (hobby_id = ' + item.hobby_id + '), error is: ');
      console.error(error);

      return 1;
    }
  }
}

async function main () {
  const db = await initialize_database();
  const data = await fetch_data();
  let post_count = 0;

  const http = (is_prod || is_test) ? axios : Axios.create({
    httpAgent: new httpsProxyAgent('http://localhost:1087'),
    httpsAgent: new httpsProxyAgent('http://localhost:1087'),
    timeout: 30000,
  })

  for (const item of data) {
    if (await check_record_existence(db, item.hobby_id, item.info_type)) {
      continue;
    }

    console.info('Found info (hobby_id = ' + item.hobby_id + ') not published, fetching tags from hpoi.net ...');
    const tags = await fetch_tags(item.hobby_id);

    console.info('Publishing info to telegram');
    if (is_prod) {
      if ((await publish_info_to_telegram(item, is_prod ? publish_channel_id : bot_owner_id, tags, http)) < 0) {
        continue;
      }

      if (tags.includes('#比例人形') && (await publish_info_to_telegram(item, is_prod ? publish_sub_channel_id : bot_owner_id, tags, http)) < 0) {
        continue;
      }

      post_count += 1;
    }

    await create_publish_record(db, item.hobby_id, item.info_type);
  }

  return post_count;
}

/** Force exit if not finish this round of publish in 5 minuts. */
setTimeout(() => {
  process.exit(1)
}, 5 * 60 * 1000);

main().then((count) => {
  console.log(`Publish process finished, new post count is ${count}`);
  process.exit(0);
}).catch((error) => {
  console.error('Publish terminated with following error: ', error);
  process.exit(1);
});
