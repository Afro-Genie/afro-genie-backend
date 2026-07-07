import 'dotenv/config';
import nodemailer from 'nodemailer';

async function testSMTP() {
  const smtpConfig = {
    host: process.env.SMTP_HOST,
    port: parseInt(process.env.SMTP_PORT || '587'),
    secure: process.env.SMTP_PORT === '465',
    auth: {
      user: process.env.SMTP_USER,
      pass: process.env.SMTP_PASS
    }
  };

  console.log('\n✅ SMTP Configuration:');
  console.log(`   Host: ${smtpConfig.host}`);
  console.log(`   Port: ${smtpConfig.port}`);
  console.log(`   Secure (TLS): ${smtpConfig.secure}`);
  console.log(`   User: ${smtpConfig.auth.user}`);
  console.log(`   Pass: ${smtpConfig.auth.pass ? '****' + smtpConfig.auth.pass.slice(-8) : 'MISSING'}`);
  console.log(`   From Email: ${process.env.SMTP_FROM_EMAIL || 'NOT SET'}\n`);

  if (!smtpConfig.host || !smtpConfig.port || !smtpConfig.auth.user || !smtpConfig.auth.pass) {
    console.error('❌ SMTP Configuration is INCOMPLETE - Missing required fields\n');
    process.exit(1);
  }

  try {
    console.log('🔄 Testing SMTP connection...');
    const transporter = nodemailer.createTransport(smtpConfig);
    
    // Verify connection
    await transporter.verify();
    console.log('✅ SMTP Connection SUCCESSFUL!\n');
    
    // Send test email
    console.log('📧 Sending test email...');
    const result = await transporter.sendMail({
      from: process.env.SMTP_FROM_EMAIL || smtpConfig.auth.user,
      to: 'test@afrogenie.com',
      subject: 'Afro Genie SMTP Test',
      html: '<h1>SMTP Test Successful!</h1><p>Your Brevo SMTP is configured and working.</p>'
    });
    
    console.log('✅ Email sent successfully!');
    console.log(`   Message ID: ${result.messageId}\n`);
    process.exit(0);
  } catch (error: any) {
    console.error('❌ SMTP Test FAILED:');
    console.error(`   Error: ${error.message}\n`);
    process.exit(1);
  }
}

testSMTP();
