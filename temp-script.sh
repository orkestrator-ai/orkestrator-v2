# Start the audit daemon so records land in /var/log/audit/audit.log
sudo systemctl start auditd
#
# # Bigger buffer so a burst of test-suite kills isn't dropped
sudo auditctl -b 8192
#
# # kill / tkill / pidfd_send_signal carry the signal in arg 1; tgkill carries it in arg 2
for sig in 9 15; do
   sudo auditctl -a always,exit -F arch=b64 -S kill -S tkill -S pidfd_send_signal -F a1=$sig -F uid=1000 -k ork-kill
     sudo auditctl -a always,exit -F arch=b64 -S tgkill -F a2=$sig -F uid=1000 -k ork-kill
done

sudo auditctl -l   # should list the 4 rules
