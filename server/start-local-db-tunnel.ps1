$EC2_HOST = "13.207.47.116"
$EC2_USER = "ec2-user"
$SSH_KEY = "$env:USERPROFILE\.ssh\ucs-backend.pem"
$RDS_HOST = "ucs-crm-db.cv8asue2a57e.ap-south-1.rds.amazonaws.com"
$LOCAL_PORT = 5434
$REMOTE_PORT = 5432

Write-Host "Opening SSH tunnel: localhost:$LOCAL_PORT -> $RDS_HOST:$REMOTE_PORT via $EC2_HOST" -ForegroundColor Cyan
Write-Host "Press Ctrl+C to stop." -ForegroundColor Yellow

ssh -i $SSH_KEY -N -L "${LOCAL_PORT}:${RDS_HOST}:${REMOTE_PORT}" "${EC2_USER}@${EC2_HOST}"
