// Fallback question bank for the recruit quiz.
// Used only when the Grok API call to generate questions fails or times out.
// Each role has 10 questions: 7 MCQ + 3 short answer.

function bank(mcq, short) {
  const questions = [
    ...mcq.map(({ question, options, answer }) => ({
      type: 'mcq',
      question,
      options,
      answer,
    })),
    ...short.map((question) => ({ type: 'short', question, answer: '' })),
  ];
  return questions.slice(0, 10);
}

export const QUIZ_BANK = {
  accounts: bank(
    [
      { question: 'What does the "Trial Balance" help verify?', options: ['That total debits equal total credits', 'That all invoices are paid', 'That cash is in the bank', 'That profit is maximized'], answer: 'That total debits equal total credits' },
      { question: 'Which financial statement shows a company’s assets and liabilities?', options: ['Income Statement', 'Balance Sheet', 'Cash Flow Statement', 'Trial Balance'], answer: 'Balance Sheet' },
      { question: 'What is the accounting equation?', options: ['Assets = Liabilities + Equity', 'Assets = Liabilities - Equity', 'Revenue = Profit - Cost', 'Income = Expenses + Assets'], answer: 'Assets = Liabilities + Equity' },
      { question: 'Which of these is a current asset?', options: ['Building', 'Machinery', 'Accounts Receivable', 'Long-term loan'], answer: 'Accounts Receivable' },
      { question: 'What is GST?', options: ['Goods and Services Tax', 'General Sales Tariff', 'Gross Sales Total', 'Government Savings Tax'], answer: 'Goods and Services Tax' },
      { question: 'Depreciation is used to:', options: ['Increase asset value', 'Allocate an asset’s cost over its useful life', 'Reduce revenue', 'Pay off debts faster'], answer: 'Allocate an asset’s cost over its useful life' },
      { question: 'Which entry records the purchase of goods on credit?', options: ['Debit Purchases, Credit Accounts Payable', 'Debit Cash, Credit Sales', 'Debit Accounts Payable, Credit Purchases', 'Debit Sales, Credit Cash'], answer: 'Debit Purchases, Credit Accounts Payable' },
    ],
    [
      'Explain the difference between a debit and a credit.',
      'How would you handle a mismatch between bank statement and ledger balances?',
      'Why is it important to reconcile accounts every month?',
    ]
  ),

  telecalling: bank(
    [
      { question: 'What is the first thing you should do when a call connects?', options: ['Start pitching immediately', 'Greet and introduce yourself', 'Ask for money right away', 'Keep silent'], answer: 'Greet and introduce yourself' },
      { question: 'A prospect says "I am not interested". What should you do?', options: ['Hang up immediately', 'Push harder aggressively', 'Stay calm, acknowledge, and try to understand why', 'Argue with them'], answer: 'Stay calm, acknowledge, and try to understand why' },
      { question: 'What does "opening ratio" mean in telecalling?', options: ['Calls answered by prospects', 'Calls rejected', 'Total calls made', 'Leads closed'], answer: 'Calls answered by prospects' },
      { question: 'Which tone is most effective on a sales call?', options: ['Bored and flat', 'Loud and aggressive', 'Friendly, confident and clear', 'Whispering'], answer: 'Friendly, confident and clear' },
      { question: 'What is the best way to handle a call back request?', options: ['Ignore it', 'Note the time and follow up as promised', 'Transfer randomly', 'Call back the same minute'], answer: 'Note the time and follow up as promised' },
      { question: 'What is a "lead"?', options: ['A person who hung up', 'A potential customer interested in your product/service', 'A completed sale', 'A complaint'], answer: 'A potential customer interested in your product/service' },
      { question: 'Before ending a call, you should always:', options: ['Summarise the next step', 'Argue once more', 'Ask for the prospect’s bank details', 'End abruptly'], answer: 'Summarise the next step' },
    ],
    [
      'How would you convince a prospect who is comparing you with a competitor?',
      'What would you do if a prospect complains about your organisation?',
      'How do you stay motivated when you face many rejections in a day?',
    ]
  ),

  'graphic designer': bank(
    [
      { question: 'Which colour model is used for print design?', options: ['RGB', 'CMYK', 'HSL', 'HEX'], answer: 'CMYK' },
      { question: 'What does "kerning" refer to?', options: ['Space between letters', 'Line spacing', 'Font weight', 'Image cropping'], answer: 'Space between letters' },
      { question: 'Which software is commonly used for vector design?', options: ['Photoshop', 'Adobe Illustrator', 'Lightroom', 'After Effects'], answer: 'Adobe Illustrator' },
      { question: 'What is a "mockup"?', options: ['A rough sketch', 'A realistic preview of the final design', 'A colour palette', 'A font style'], answer: 'A realistic preview of the final design' },
      { question: 'What is the rule of thirds used for?', options: ['Colour selection', 'Composition', 'Typography', 'File exporting'], answer: 'Composition' },
      { question: 'Which file format supports transparency and is ideal for logos?', options: ['JPEG', 'PNG', 'BMP', 'GIF (8-bit)'], answer: 'PNG' },
      { question: 'What is white space in design?', options: ['A white background only', 'Empty space used to balance a layout', 'Invisible text', 'A blank file'], answer: 'Empty space used to balance a layout' },
    ],
    [
      'Explain your design process from brief to final delivery.',
      'How do you handle feedback that you disagree with?',
      'What is the difference between raster and vector images?',
    ]
  ),

  'web app developer': bank(
    [
      { question: 'Which HTML tag is used for the largest heading?', options: ['<h6>', '<heading>', '<h1>', '<head>'], answer: '<h1>' },
      { question: 'What does CSS stand for?', options: ['Cascading Style Sheets', 'Computer Style System', 'Creative Style Sheets', 'Cascading Script Sheets'], answer: 'Cascading Style Sheets' },
      { question: 'Which of these is a JavaScript framework?', options: ['React', 'Django', 'Laravel', 'Flask'], answer: 'React' },
      { question: 'What is an API?', options: ['A database', 'A way for software to communicate', 'A programming language', 'A type of server'], answer: 'A way for software to communicate' },
      { question: 'Which method is used to make an HTTP POST request in JavaScript?', options: ['fetch()', 'console.log()', 'query()', 'render()'], answer: 'fetch()' },
      { question: 'What does SQL stand for?', options: ['Structured Query Language', 'Simple Question Language', 'System Query List', 'Server Query Language'], answer: 'Structured Query Language' },
      { question: 'What is the correct way to declare a constant in JavaScript?', options: ['var name', 'let name', 'const name', 'define name'], answer: 'const name' },
    ],
    [
      'What is the difference between "==" and "===" in JavaScript?',
      'Explain what a REST API is in simple terms.',
      'How do you debug a web application when something is not working?',
    ]
  ),

  hr: bank(
    [
      { question: 'What does HR primarily focus on?', options: ['Only recruitment', 'Managing the organisation’s people, culture and compliance', 'Only payroll', 'Only attendance'], answer: 'Managing the organisation’s people, culture and compliance' },
      { question: 'What is an employment contract?', options: ['A verbal promise', 'A legal agreement between employer and employee', 'A resume', 'A leave form'], answer: 'A legal agreement between employer and employee' },
      { question: 'What does "onboarding" mean?', options: ['Firing an employee', 'Integrating a new employee into the organisation', 'Promoting an employee', 'Transferring an employee'], answer: 'Integrating a new employee into the organisation' },
      { question: 'Which act commonly protects employee rights in India?', options: ['Companies Act', 'Factories Act', 'GST Act', 'IT Act'], answer: 'Factories Act' },
      { question: 'What is the purpose of a performance review?', options: ['To punish employees', 'To evaluate performance and set future goals', 'To reduce salary', 'To fire employees'], answer: 'To evaluate performance and set future goals' },
      { question: 'What is statutory compliance in HR?', options: ['Optional suggestions', 'Following legal regulations like PF, ESI, and gratuity', 'Employee suggestions', 'Office policies only'], answer: 'Following legal regulations like PF, ESI, and gratuity' },
      { question: 'What should you do first when an employee resigns?', options: ['Delete their file', 'Acknowledge, understand reasons, and begin the offboarding process', 'Ignore them', 'Cancel their salary'], answer: 'Acknowledge, understand reasons, and begin the offboarding process' },
    ],
    [
      'How would you handle a conflict between two employees?',
      'Why is employee engagement important?',
      'What steps would you take to improve the hiring process?',
    ]
  ),
};

export const GENERIC_BANK = bank(
  [
    { question: 'Tell us which role you are applying for and your main skill.', options: ['I can type it in the next section', 'It is my strongest skill', 'I am good with people', 'I am good with tools'], answer: 'It is my strongest skill' },
    { question: 'What does a good attitude at work mean to you?', options: ['Being on time and willing to learn', 'Doing only the minimum', 'Talking a lot', 'Avoiding responsibility'], answer: 'Being on time and willing to learn' },
    { question: 'How do you usually communicate with a team?', options: ['Clearly and respectfully', 'By shouting', 'Only through gossip', 'Rarely'], answer: 'Clearly and respectfully' },
    { question: 'When you do not understand a task, you should:', options: ['Guess randomly', 'Ask for clarification', 'Skip the task', 'Blame someone else'], answer: 'Ask for clarification' },
    { question: 'Which tool do you use most often in your work?', options: ['A computer / phone', 'A hammer', 'A calculator only', 'None'], answer: 'A computer / phone' },
    { question: 'How do you handle a tight deadline?', options: ['Panic and stop', 'Plan, prioritise and work efficiently', 'Ignore it', 'Do it carelessly'], answer: 'Plan, prioritise and work efficiently' },
    { question: 'What is most important for teamwork?', options: ['Trust and communication', 'Competition', 'Silence', 'Being the loudest'], answer: 'Trust and communication' },
  ],
  [
    'Why do you want to work with our organisation?',
    'Describe a time you solved a problem at work.',
    'What are your strengths and weaknesses?',
  ]
);

// General knowledge fallback used when the AI quiz generation fails.
export const GK_BANK = bank(
  [
    { question: 'What is the capital of India?', options: ['New Delhi', 'Mumbai', 'Kolkata', 'Chennai'], answer: 'New Delhi' },
    { question: 'Which is the largest planet in our solar system?', options: ['Earth', 'Mars', 'Jupiter', 'Saturn'], answer: 'Jupiter' },
    { question: 'How many continents are there in the world?', options: ['5', '6', '7', '8'], answer: '7' },
    { question: 'Which gas do plants absorb from the air?', options: ['Oxygen', 'Carbon dioxide', 'Nitrogen', 'Hydrogen'], answer: 'Carbon dioxide' },
    { question: 'How many days are there in a leap year?', options: ['365', '366', '364', '360'], answer: '366' },
    { question: 'Which is the national flower of India?', options: ['Rose', 'Sunflower', 'Lotus', 'Marigold'], answer: 'Lotus' },
    { question: 'Which of these is a continent?', options: ['India', 'Africa', 'China', 'England'], answer: 'Africa' },
  ],
  [
    'Name any one current event you recently read or watched in the news.',
    'Why is general awareness important for everyday life?',
    'Name one famous Indian freedom fighter and his or her contribution.',
  ]
);
